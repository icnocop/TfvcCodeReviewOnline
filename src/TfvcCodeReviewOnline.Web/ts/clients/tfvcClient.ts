/**
 * Lists the files a code review covers.
 *
 * The heavy lifting is done by Microsoft's own `TFS/VersionControl/TfvcRestClient`, so there is no
 * hand-rolled REST plumbing or auth handling here. This module narrows that client to the two calls
 * the extension needs and normalizes the result, which keeps it testable without the platform SDK
 * (the adapter over the real client lives in ts/platform/vssPlatform.ts).
 */

import type { ReviewTarget } from './workItemContext';

/** A file in a review, with both sides of the comparison identified. */
export interface ReviewedFile {
    /** Server path, for example `$/ExampleProject/src/Sample.cs`. */
    readonly path: string;
    /**
     * Server path of the base version, which differs from `path` for a rename. Fetching the base
     * side at the new path would fail, because at the base changeset the file was still called
     * something else.
     */
    readonly basePath: string;
    /** `edit`, `add`, `delete`, `rename`, or a combination such as `edit, rename`. */
    readonly changeType: string;
    /**
     * Changeset the change is based on, which is the version to diff against. Undefined for an
     * added file, which has no base side.
     */
    readonly baseVersion: number | undefined;
    /** Version descriptor for the reviewed ("after") side of this file. */
    readonly reviewedVersion: TfvcVersion;
}

/** Identifies one version of an item, mirroring the REST API's version descriptor. */
export interface TfvcVersion {
    readonly versionType: 'Shelveset' | 'Changeset';
    readonly version: string;
}

/**
 * The part of `TfvcRestClient` this module uses.
 *
 * `TfvcChange` is deliberately modelled loosely: the platform contract carries many more fields
 * than the extension reads, and pinning them all down here would couple this module to an SDK
 * version for no benefit.
 */
export interface TfvcChangeSource {
    getShelvesetChanges(shelvesetId: string): PromiseLike<readonly RawTfvcChange[]>;
    getChangesetChanges(changesetId: number): PromiseLike<readonly RawTfvcChange[]>;
}

export interface RawTfvcChange {
    readonly changeType?: unknown;
    /** Path before the change; present and different from `item.path` on a rename. */
    readonly sourceServerItem?: unknown;
    readonly item?: {
        readonly path?: unknown;
        readonly version?: unknown;
    };
}

/** Reads the text of one version of one file. */
export interface TfvcContentSource {
    getFileText(path: string, version: TfvcVersion): PromiseLike<string>;
}

/**
 * Normalizes the REST API's `changeType`.
 *
 * The API returns it as a string ("edit", "add, rename") on the routes this extension uses, but the
 * generated contract types it as a numeric flags enum, so both forms are accepted rather than
 * assuming one.
 */
export function describeChangeType(changeType: unknown): string {
    if (typeof changeType === 'string' && changeType.length > 0) {
        return changeType;
    }
    if (typeof changeType === 'number') {
        return describeChangeTypeFlags(changeType);
    }
    return 'unknown';
}

// Values of the VersionControlChangeType flags enum, which the REST layer sometimes returns instead
// of its string form.
const CHANGE_TYPE_FLAGS: readonly (readonly [number, string])[] = [
    [1, 'add'],
    [2, 'edit'],
    [4, 'encoding'],
    [8, 'rename'],
    [16, 'delete'],
    [32, 'undelete'],
    [64, 'branch'],
    [128, 'merge'],
    [256, 'lock'],
    [512, 'rollback'],
    [1024, 'sourceRename'],
    [2048, 'targetRename'],
    [4096, 'property'],
];

function describeChangeTypeFlags(changeType: number): string {
    const names = CHANGE_TYPE_FLAGS
        .filter(([flag]) => (changeType & flag) === flag)
        .map(([, name]) => name);
    return names.length > 0 ? names.join(', ') : 'unknown';
}

/** True when a change has no base side to diff against. */
export function isAdd(changeType: string): boolean {
    return /\badd\b/i.test(changeType) || /\bbranch\b/i.test(changeType);
}

/** True when a change has no reviewed side to display. */
export function isDelete(changeType: string): boolean {
    return /\bdelete\b/i.test(changeType);
}

function asOptionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function toReviewedFile(change: RawTfvcChange, reviewedVersion: TfvcVersion): ReviewedFile | undefined {
    const path = change.item?.path;
    if (typeof path !== 'string' || path.length === 0) {
        // A change with no server path is not something that can be displayed or matched to a
        // discussion thread, so it is dropped rather than rendered as a blank row.
        return undefined;
    }

    const changeType = describeChangeType(change.changeType);
    const sourceServerItem = change.sourceServerItem;

    return {
        path,
        basePath: typeof sourceServerItem === 'string' && sourceServerItem.length > 0
            ? sourceServerItem
            : path,
        changeType,
        baseVersion: isAdd(changeType) ? undefined : asOptionalNumber(change.item?.version),
        reviewedVersion,
    };
}

/** Lists the files covered by a review, whichever kind of context it uses. */
export async function listReviewedFiles(
    source: TfvcChangeSource,
    target: ReviewTarget): Promise<readonly ReviewedFile[]> {
    if (target.kind === 'unknown') {
        throw new Error(target.reason);
    }

    if (target.kind === 'shelveset') {
        const changes = await source.getShelvesetChanges(target.shelvesetId);
        // The reviewed side is identified by name;DOMAIN\user in item URLs but by name;{ownerGuid}
        // on the shelvesets route. The version descriptor wants whatever the shelveset ID is, which
        // is the GUID form the work item gives us.
        const reviewedVersion: TfvcVersion = {
            versionType: 'Shelveset',
            version: target.shelvesetId,
        };
        return normalize(changes, reviewedVersion);
    }

    const changes = await source.getChangesetChanges(target.changesetId);
    const reviewedVersion: TfvcVersion = {
        versionType: 'Changeset',
        version: String(target.changesetId),
    };
    return normalize(changes, reviewedVersion);
}

function normalize(
    changes: readonly RawTfvcChange[],
    reviewedVersion: TfvcVersion): readonly ReviewedFile[] {
    const files: ReviewedFile[] = [];
    for (const change of changes) {
        const file = toReviewedFile(change, reviewedVersion);
        if (file !== undefined) {
            files.push(file);
        }
    }
    // Sorted by path so the file list is stable between loads; the API's order is not guaranteed.
    return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Both versions of one file's text, or an explanation of why one of them is missing. */
export interface ReviewedFileContent {
    /** Empty for an added file, which has no base version. */
    readonly baseText: string;
    /** Empty for a deleted file, which has no reviewed version. */
    readonly reviewedText: string;
    /** True when the content is not text and must not be rendered as a line diff. */
    readonly isBinary: boolean;
    /** Set when something could not be fetched, phrased for display next to the file. */
    readonly note: string | undefined;
}

/**
 * Recognizes content that is not text.
 *
 * The item routes return whatever bytes the file holds decoded as text, so a `.dll` or a `.png`
 * comes back as a string full of replacement characters and NULs. A NUL is the reliable signal:
 * text files do not contain one, and every common binary format does within its first few hundred
 * bytes. Only the head is examined, because the point is to decide quickly, not exhaustively.
 */
export function looksBinary(text: string): boolean {
    return text.slice(0, 8000).indexOf('\u0000') >= 0;
}

async function fetchOptionalText(
    source: TfvcContentSource,
    path: string,
    version: TfvcVersion,
    failures: string[],
    description: string): Promise<string> {
    try {
        return await source.getFileText(path, version);
    } catch (error) {
        failures.push(
            `${description} could not be read: ${error instanceof Error ? error.message : String(error)}`);
        return '';
    }
}

/**
 * Fetches both versions of a file's text.
 *
 * A failure on one side is recorded and does not fail the call. The reason is that the review
 * comments are the point of this tab: a shelveset that has since been deleted, or a base version
 * behind a permission the reader lacks, should cost the diff and nothing else.
 */
export async function loadFileContent(
    source: TfvcContentSource,
    file: ReviewedFile): Promise<ReviewedFileContent> {
    const failures: string[] = [];

    const wantsBase = file.baseVersion !== undefined && !isAdd(file.changeType);
    const wantsReviewed = !isDelete(file.changeType);

    const [baseText, reviewedText] = await Promise.all([
        wantsBase && file.baseVersion !== undefined
            ? fetchOptionalText(
                source,
                file.basePath,
                { versionType: 'Changeset', version: String(file.baseVersion) },
                failures,
                `The base version (changeset ${file.baseVersion})`)
            : Promise.resolve(''),
        wantsReviewed
            ? fetchOptionalText(source, file.path, file.reviewedVersion, failures, 'The reviewed version')
            : Promise.resolve(''),
    ]);

    return {
        baseText,
        reviewedText,
        isBinary: looksBinary(baseText) || looksBinary(reviewedText),
        note: failures.length > 0 ? failures.join(' ') : undefined,
    };
}
