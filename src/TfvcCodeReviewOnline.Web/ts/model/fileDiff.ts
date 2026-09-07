/**
 * Turns the two fetched versions of a file into something renderable, or into a plain explanation of
 * why there is nothing to render.
 *
 * Kept separate from both the fetching and the rendering so the rules -- a binary file has no line
 * diff, a delete shows its old content, a file whose only change is a property carries no line
 * changes at all -- are decided in one place and can be asserted without a DOM or a server.
 */

import type { ReviewedFile, ReviewedFileContent } from '../clients/tfvcClient';
import { isAdd, isDelete } from '../clients/tfvcClient';
import { diffLines, type DiffLine, type DiffOptions } from './diff';

export interface FileDiffResult {
    /** The rendered diff, or undefined when the file has none to show. */
    readonly lines: readonly DiffLine[] | undefined;
    /** Shown in place of, or alongside, the diff. */
    readonly note: string | undefined;
}

/** Short description of what happened to a file, for the row above its diff. */
export function describeFileChange(file: ReviewedFile): string {
    if (isAdd(file.changeType)) {
        return 'Added in this review.';
    }
    if (isDelete(file.changeType)) {
        return 'Deleted in this review.';
    }
    if (file.basePath !== file.path) {
        return `Renamed from ${file.basePath}.`;
    }
    return '';
}

export function buildFileDiff(
    content: ReviewedFileContent,
    options?: DiffOptions): FileDiffResult {
    if (content.isBinary) {
        return {
            lines: undefined,
            // Threads on a binary file are still shown; only the diff is impossible.
            note: joinNotes(content.note, 'This is a binary file, so there is no line diff to show.'),
        };
    }

    const lines = diffLines(content.baseText, content.reviewedText, options);

    if (lines.length === 0) {
        return {
            lines: undefined,
            note: joinNotes(
                content.note,
                content.note === undefined
                    ? 'This file has no line changes. The change may be to a property such as its '
                        + 'encoding or lock state.'
                    : undefined),
        };
    }

    return { lines, note: content.note };
}

function joinNotes(...notes: readonly (string | undefined)[]): string | undefined {
    const present = notes.filter((note): note is string => note !== undefined && note !== '');
    return present.length > 0 ? present.join(' ') : undefined;
}
