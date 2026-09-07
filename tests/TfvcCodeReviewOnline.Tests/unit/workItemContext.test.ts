import { describe, expect, it } from 'vitest';

import {
    buildClosingFields,
    closeReview,
    CODE_REVIEW_REQUEST_WORK_ITEM_TYPE,
    readReviewContext,
    resolveShelvesetId,
    REVIEW_FIELD_NAMES,
    ReviewContextCode,
    type WorkItemFieldReader,
    type WorkItemFieldWriter,
} from '../../../src/TfvcCodeReviewOnline.Web/ts/clients/workItemContext';

/** A stand-in for the host's work item form service. */
function fieldReader(
    workItemId: number,
    fields: { readonly [fieldReferenceName: string]: unknown }): WorkItemFieldReader & {
        requestedFields: string[];
    } {
    const requestedFields: string[] = [];
    return {
        requestedFields,
        getId: () => Promise.resolve(workItemId),
        getFieldValues: (fieldReferenceNames) => {
            requestedFields.push(...fieldReferenceNames);
            return Promise.resolve(fields);
        },
    };
}

const SHELVESET_REVIEW_FIELDS = {
    [REVIEW_FIELD_NAMES.workItemType]: CODE_REVIEW_REQUEST_WORK_ITEM_TYPE,
    [REVIEW_FIELD_NAMES.title]: 'Adds retry handling around the import step',
    [REVIEW_FIELD_NAMES.contextCode]: 1,
    [REVIEW_FIELD_NAMES.contextType]: 'Shelveset',
    [REVIEW_FIELD_NAMES.context]: 'CodeReview_2026-04-07_10.48.58.7693',
    [REVIEW_FIELD_NAMES.contextOwner]: '00000000-0000-4000-8000-000000000001',
};

describe('resolveShelvesetId', () => {
    it('joins the shelveset name to the owner GUID', () => {
        // The TFVC REST API's /shelvesets/{id} route requires name;{ownerGuid}. The name;DOMAIN\user
        // form that the web UI uses in its ?ss= parameter returns 404 there, which is why the owner
        // GUID from the work item is the value that matters.
        expect(resolveShelvesetId('CodeReview_2026-04-07', '00000000-0000-4000-8000-000000000001'))
            .toBe('CodeReview_2026-04-07;00000000-0000-4000-8000-000000000001');
    });

    it('returns nothing when either half is missing', () => {
        expect(resolveShelvesetId(undefined, '00000000-0000-4000-8000-000000000001')).toBeUndefined();
        expect(resolveShelvesetId('CodeReview_2026-04-07', undefined)).toBeUndefined();
        expect(resolveShelvesetId('', '')).toBeUndefined();
    });
});

describe('readReviewContext', () => {
    it('requests exactly the fields it reads', async () => {
        const reader = fieldReader(1234, SHELVESET_REVIEW_FIELDS);

        await readReviewContext(reader);

        expect(reader.requestedFields.sort()).toEqual(Object.values(REVIEW_FIELD_NAMES).sort());
    });

    it('resolves a shelveset review to a shelveset target', async () => {
        const context = await readReviewContext(fieldReader(1234, SHELVESET_REVIEW_FIELDS));

        expect(context.workItemId).toBe(1234);
        expect(context.isCodeReviewRequest).toBe(true);
        expect(context.contextCode).toBe(ReviewContextCode.Shelveset);
        expect(context.target).toEqual({
            kind: 'shelveset',
            shelvesetName: 'CodeReview_2026-04-07_10.48.58.7693',
            shelvesetId: 'CodeReview_2026-04-07_10.48.58.7693;00000000-0000-4000-8000-000000000001',
        });
    });

    it('resolves a changeset review to a changeset target', async () => {
        const context = await readReviewContext(fieldReader(1235, {
            ...SHELVESET_REVIEW_FIELDS,
            [REVIEW_FIELD_NAMES.contextCode]: 2,
            [REVIEW_FIELD_NAMES.contextType]: 'Changeset',
            [REVIEW_FIELD_NAMES.context]: '23113',
            [REVIEW_FIELD_NAMES.contextOwner]: undefined,
        }));

        expect(context.target).toEqual({ kind: 'changeset', changesetId: 23113 });
    });

    it('reports a work item that is not a code review request', async () => {
        const context = await readReviewContext(fieldReader(99, {
            [REVIEW_FIELD_NAMES.workItemType]: 'Bug',
            [REVIEW_FIELD_NAMES.title]: 'Import fails on a UNC share',
        }));

        expect(context.isCodeReviewRequest).toBe(false);
        expect(context.workItemType).toBe('Bug');
        expect(context.target.kind).toBe('unknown');
    });

    it('explains an unresolvable target rather than throwing', async () => {
        // A review whose shelveset fields are missing should still render its comments, so this has
        // to degrade to a message instead of failing the load.
        const context = await readReviewContext(fieldReader(1234, {
            ...SHELVESET_REVIEW_FIELDS,
            [REVIEW_FIELD_NAMES.context]: undefined,
        }));

        expect(context.isCodeReviewRequest).toBe(true);
        expect(context.target).toEqual({
            kind: 'unknown',
            reason: 'The review is for a shelveset, but its name or owner is missing from the work item.',
        });
    });

    it('explains an unrecognized context code', async () => {
        const context = await readReviewContext(fieldReader(1234, {
            ...SHELVESET_REVIEW_FIELDS,
            [REVIEW_FIELD_NAMES.contextCode]: 7,
        }));

        expect(context.target).toEqual({
            kind: 'unknown',
            reason: "Unrecognized review context code '7'.",
        });
    });

    it('reports an open review as open', async () => {
        const context = await readReviewContext(fieldReader(1234, {
            ...SHELVESET_REVIEW_FIELDS,
            [REVIEW_FIELD_NAMES.state]: 'Requested',
        }));

        expect(context.isClosed).toBe(false);
        expect(context.closedStatus).toBeUndefined();
    });

    it('reports how a closed review ended', async () => {
        const context = await readReviewContext(fieldReader(1234, {
            ...SHELVESET_REVIEW_FIELDS,
            [REVIEW_FIELD_NAMES.state]: 'Closed',
            [REVIEW_FIELD_NAMES.closedStatus]: 'Abandoned',
        }));

        expect(context.isClosed).toBe(true);
        expect(context.state).toBe('Closed');
        expect(context.closedStatus).toBe('Abandoned');
    });

    it('accepts field values that arrive as strings', async () => {
        // The form service returns field values as Object, and numeric fields have been seen as
        // both numbers and strings depending on whether the value came from the form or the store.
        const context = await readReviewContext(fieldReader(1234, {
            ...SHELVESET_REVIEW_FIELDS,
            [REVIEW_FIELD_NAMES.contextCode]: '1',
        }));

        expect(context.contextCode).toBe(1);
        expect(context.target.kind).toBe('shelveset');
    });
});

describe('buildClosingFields', () => {
    it('writes the state and the status, and nothing the work item type fills in itself', () => {
        // ClosedBy, ClosedDate, Reason, StateCode and the cleared AssignedTo are all set by rules on
        // the Requested -> Closed transition. ClosedStatusCode is read-only until that transition and
        // is derived from the status written here. See docs/api-contract.md.
        expect(buildClosingFields('checkedIn', '')).toEqual({
            'System.State': 'Closed',
            'Microsoft.VSTS.CodeReview.ClosedStatus': 'Checked-in',
        });
    });

    it('names an abandoned review as the work item type names it', () => {
        expect(buildClosingFields('abandoned', '')['Microsoft.VSTS.CodeReview.ClosedStatus'])
            .toBe('Abandoned');
    });

    it('records a closing note on the review history', () => {
        expect(buildClosingFields('abandoned', '  Superseded by changeset 23112.  ')).toEqual({
            'System.State': 'Closed',
            'Microsoft.VSTS.CodeReview.ClosedStatus': 'Abandoned',
            'System.History': 'Superseded by changeset 23112.',
        });
    });

    it('adds no history entry for a note that is only whitespace', () => {
        expect(buildClosingFields('checkedIn', '   ')['System.History']).toBeUndefined();
    });
});

describe('closeReview', () => {
    function fieldWriter(
        accepted: { readonly [fieldReferenceName: string]: boolean } | undefined): WorkItemFieldWriter
        & { written: unknown[]; saves: number } {
        const written: unknown[] = [];
        const writer = {
            written,
            saves: 0,
            setFieldValues: (fields: { readonly [name: string]: unknown }) => {
                written.push(fields);
                return Promise.resolve(accepted);
            },
            save: () => {
                writer.saves++;
                return Promise.resolve();
            },
        };
        return writer;
    }

    it('sets the fields and then saves', async () => {
        const writer = fieldWriter({
            'System.State': true,
            'Microsoft.VSTS.CodeReview.ClosedStatus': true,
        });

        await closeReview(writer, 'checkedIn', '');

        expect(writer.written).toEqual([{
            'System.State': 'Closed',
            'Microsoft.VSTS.CodeReview.ClosedStatus': 'Checked-in',
        }]);
        expect(writer.saves).toBe(1);
    });

    it('does not save when the form refused a field', async () => {
        // Otherwise the save would go ahead and store the note without the state change -- a review
        // that looks commented on and is still open, with nothing to say why.
        const writer = fieldWriter({
            'System.State': false,
            'Microsoft.VSTS.CodeReview.ClosedStatus': true,
        });

        await expect(closeReview(writer, 'checkedIn', '')).rejects.toThrow('System.State');
        expect(writer.saves).toBe(0);
    });

    it('saves when the form reports nothing about the fields', async () => {
        // Some host versions resolve setFieldValues with no result at all; that is not a refusal.
        const writer = fieldWriter(undefined);

        await closeReview(writer, 'abandoned', '');

        expect(writer.saves).toBe(1);
    });
});
