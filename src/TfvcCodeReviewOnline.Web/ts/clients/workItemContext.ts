/**
 * Reads what is being reviewed off the Code Review Request work item.
 *
 * A code review's identity lives in four fields on the work item, and everything else -- the
 * shelveset, the changed files, the base versions -- is derived from them. Deliberately free of any
 * platform SDK import so it can be unit-tested directly; the adapter that supplies a real work item
 * form service lives in ts/platform/vssPlatform.ts.
 */

/** Work item type whose form hosts the review. */
export const CODE_REVIEW_REQUEST_WORK_ITEM_TYPE = 'Code Review Request';

/** Field reference names the extension reads. */
export const REVIEW_FIELD_NAMES = {
    workItemType: 'System.WorkItemType',
    title: 'System.Title',
    /** `Requested` while the review is open, `Closed` once it has been closed. */
    state: 'System.State',
    /** How a closed review ended: `Checked-in`, `Abandoned`, or `Completed`. */
    closedStatus: 'Microsoft.VSTS.CodeReview.ClosedStatus',
    /** 1 = shelveset, 2 = changeset. */
    contextCode: 'Microsoft.VSTS.CodeReview.ContextCode',
    /** Human-readable counterpart of `contextCode`, for example "Shelveset". */
    contextType: 'Microsoft.VSTS.CodeReview.ContextType',
    /** Shelveset name, or changeset number for a changeset review. */
    context: 'Microsoft.VSTS.CodeReview.Context',
    /** Identity GUID of whoever owns the shelveset. */
    contextOwner: 'Microsoft.VSTS.CodeReview.ContextOwner',
} as const;

/** Value of `Microsoft.VSTS.CodeReview.ContextCode`. */
export enum ReviewContextCode {
    Shelveset = 1,
    Changeset = 2,
}

/** What a review points at, resolved into something the TFVC client can query. */
export type ReviewTarget =
    | { readonly kind: 'shelveset'; readonly shelvesetId: string; readonly shelvesetName: string }
    | { readonly kind: 'changeset'; readonly changesetId: number }
    | { readonly kind: 'unknown'; readonly reason: string };

/** The state a Code Review Request is in once it has been closed. */
export const CLOSED_STATE = 'Closed';

/**
 * How a review ended, in the two forms Visual Studio offers on its Close Review menu.
 *
 * The work item type allows a third value, `Completed`, which no Visual Studio action writes; it is
 * left out here rather than offered as a choice whose meaning nothing else in the system agrees on.
 */
export type ReviewClosure = 'checkedIn' | 'abandoned';

/** What each closure is called in `Microsoft.VSTS.CodeReview.ClosedStatus`. */
export const CLOSED_STATUS_VALUES: { readonly [TClosure in ReviewClosure]: string } = {
    checkedIn: 'Checked-in',
    abandoned: 'Abandoned',
};

export interface ReviewContext {
    readonly workItemId: number;
    readonly workItemType: string;
    readonly title: string;
    /** False for any work item that is not a Code Review Request; the tab renders an empty state. */
    readonly isCodeReviewRequest: boolean;
    readonly state: string;
    /** Set only on a closed review, and only where the work item recorded how it ended. */
    readonly closedStatus: string | undefined;
    /** True once the review has been closed, which it cannot be undone from -- see below. */
    readonly isClosed: boolean;
    readonly contextCode: number | undefined;
    readonly contextType: string | undefined;
    readonly context: string | undefined;
    readonly contextOwner: string | undefined;
    readonly target: ReviewTarget;
}

/**
 * The part of the platform's work item form service this module reads through.
 *
 * Narrowed to two methods so the tests can supply a plain object instead of the SDK. Writing has its
 * own interface below, kept separate so that the reading path cannot reach a mutating method by
 * accident.
 */
export interface WorkItemFieldReader {
    getId(): PromiseLike<number>;
    getFieldValues(
        fieldReferenceNames: string[]): PromiseLike<{ readonly [fieldReferenceName: string]: unknown }>;
}

/**
 * The part of the form service used to close a review.
 *
 * Going through the *form* rather than the REST API is deliberate. The form is what the reader is
 * looking at: it applies the work item type's rules as the fields change, it refuses a change the
 * type does not allow, and it saves the same revision the reader would have saved by hand. A REST
 * PATCH would write behind the form's back and leave an open form holding a stale revision, which
 * the next save would then conflict on.
 */
export interface WorkItemFieldWriter {
    setFieldValues(fields: { readonly [fieldReferenceName: string]: unknown }):
        PromiseLike<{ readonly [fieldReferenceName: string]: boolean } | undefined>;
    save(): PromiseLike<void>;
}

/**
 * The fields to write in order to close a review.
 *
 * Deliberately short. Closing is a state transition, and the work item type's own transition rules
 * fill in `ClosedBy`, `ClosedDate`, `System.Reason`, `StateCode`, and the cleared `AssignedTo`.
 * `ClosedStatusCode` is left alone on purpose: it is read-only until the transition happens, and a
 * pair of rules keeps it in step with the status written here. See docs/api-contract.md.
 */
export function buildClosingFields(
    closure: ReviewClosure,
    comment: string): { readonly [fieldReferenceName: string]: string } {
    const fields: { [fieldReferenceName: string]: string } = {
        [REVIEW_FIELD_NAMES.state]: CLOSED_STATE,
        [REVIEW_FIELD_NAMES.closedStatus]: CLOSED_STATUS_VALUES[closure],
    };

    const trimmed = comment.trim();
    if (trimmed !== '') {
        // Where Visual Studio puts a closing note, and where the work item form shows it.
        fields['System.History'] = trimmed;
    }

    return fields;
}

/**
 * Closes the review the form is showing.
 *
 * The result of `setFieldValues` is checked rather than assumed: it reports per field whether the
 * form accepted the change, and a rejected `System.State` would otherwise be followed by a save that
 * quietly stored nothing but the comment.
 */
export async function closeReview(
    writer: WorkItemFieldWriter,
    closure: ReviewClosure,
    comment: string): Promise<void> {
    const fields = buildClosingFields(closure, comment);
    const results = await writer.setFieldValues(fields);

    const rejected = Object.keys(results ?? {}).filter((name) => results?.[name] === false);
    if (rejected.length > 0) {
        throw new Error(
            `The work item form would not accept ${rejected.join(', ')}. The review may already be `
            + 'closed, or you may not have permission to close it.');
    }

    await writer.save();
}

function asOptionalString(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    return String(value);
}

function asOptionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Builds the shelveset ID that the TFVC REST API expects.
 *
 * The API wants `name;{ownerGuid}`. Note that this is *not* the form the web UI uses in its `?ss=`
 * query parameter, which is `name;DOMAIN\user`: passing that form to `/_apis/tfvc/shelvesets/{id}`
 * returns 404. The work item conveniently stores the owner as a GUID already.
 */
export function resolveShelvesetId(
    shelvesetName: string | undefined,
    contextOwner: string | undefined): string | undefined {
    if (!shelvesetName || !contextOwner) {
        return undefined;
    }
    return `${shelvesetName};${contextOwner}`;
}

function resolveTarget(
    contextCode: number | undefined,
    context: string | undefined,
    contextOwner: string | undefined): ReviewTarget {
    switch (contextCode) {
        case ReviewContextCode.Shelveset: {
            const shelvesetId = resolveShelvesetId(context, contextOwner);
            if (shelvesetId === undefined || context === undefined) {
                return {
                    kind: 'unknown',
                    reason: 'The review is for a shelveset, but its name or owner is missing from the work item.',
                };
            }
            return { kind: 'shelveset', shelvesetId, shelvesetName: context };
        }
        case ReviewContextCode.Changeset: {
            const changesetId = asOptionalNumber(context);
            if (changesetId === undefined) {
                return {
                    kind: 'unknown',
                    reason: 'The review is for a changeset, but the work item does not hold a changeset number.',
                };
            }
            return { kind: 'changeset', changesetId };
        }
        default:
            return {
                kind: 'unknown',
                reason: contextCode === undefined
                    ? 'The work item does not say what this review targets.'
                    : `Unrecognized review context code '${contextCode}'.`,
            };
    }
}

/** Reads and interprets the review fields on the active work item. */
export async function readReviewContext(reader: WorkItemFieldReader): Promise<ReviewContext> {
    const fieldNames = Object.values(REVIEW_FIELD_NAMES) as string[];
    const [workItemId, fieldValues] = await Promise.all([
        reader.getId(),
        reader.getFieldValues(fieldNames),
    ]);

    const workItemType = asOptionalString(fieldValues[REVIEW_FIELD_NAMES.workItemType]) ?? '';
    const contextCode = asOptionalNumber(fieldValues[REVIEW_FIELD_NAMES.contextCode]);
    const context = asOptionalString(fieldValues[REVIEW_FIELD_NAMES.context]);
    const contextOwner = asOptionalString(fieldValues[REVIEW_FIELD_NAMES.contextOwner]);
    const state = asOptionalString(fieldValues[REVIEW_FIELD_NAMES.state]) ?? '';

    return {
        workItemId,
        workItemType,
        title: asOptionalString(fieldValues[REVIEW_FIELD_NAMES.title]) ?? '',
        isCodeReviewRequest: workItemType === CODE_REVIEW_REQUEST_WORK_ITEM_TYPE,
        state,
        closedStatus: asOptionalString(fieldValues[REVIEW_FIELD_NAMES.closedStatus]),
        isClosed: state === CLOSED_STATE,
        contextCode,
        contextType: asOptionalString(fieldValues[REVIEW_FIELD_NAMES.contextType]),
        context,
        contextOwner,
        target: resolveTarget(contextCode, context, contextOwner),
    };
}
