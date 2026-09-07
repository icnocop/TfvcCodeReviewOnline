/**
 * Places a thread against a row of the rendered diff.
 *
 * A thread's anchor is a line number plus which buffer it refers to, and a rendered row may show a
 * line from either buffer or from both, so the two have to be reconciled before anything can be
 * rendered. The other job here is to be honest about stale anchors: a comment on line 946 of a file
 * the shelveset has since shortened has nowhere to go, and the answer is to say so rather than to
 * attach it to whatever now occupies that line.
 */

import type { ReviewThread, ReviewThreadPosition } from '../clients/discussionRestClient';
import { findRowIndex, type DiffRow } from './diffRows';

/** Which of the two versions of the file a thread's line number refers to. */
export type AnchorSide = 'base' | 'reviewed';

/**
 * Last line a thread's anchor actually covers.
 *
 * A position is a text selection, and its end is exclusive. Visual Studio records a comment on line
 * 19 alone as `StartLine 19, EndLine 20, EndColumn 1`: the selection runs to the first character of
 * line 20 without including any of it. Taking `EndLine` at face value therefore puts every
 * multi-line anchor one line too low and describes a single-line comment as covering two.
 *
 * Verified both ways against Visual Studio -- a thread written with `EndLine 11, EndColumn 1` renders
 * on line 10, and VS's own threads read back with the same convention.
 *
 * The adjustment is applied only when the column is known to sit at the start of a line. A position
 * whose `EndColumn` is absent carries no evidence either way, and moving the anchor on a guess would
 * be worse than leaving it where it was recorded.
 */
export function inclusiveEndLine(position: ReviewThreadPosition): number {
    const endsAtLineStart = position.endColumn !== undefined && position.endColumn <= 1;
    return endsAtLineStart && position.endLine > position.startLine
        ? position.endLine - 1
        : Math.max(position.endLine, position.startLine);
}

/**
 * Resolves the buffer a thread is anchored to.
 *
 * `LeftBuffer` is the base version, anything else -- including a missing value -- the reviewed one.
 * Defaulting to the reviewed side is deliberate: that is where the overwhelming majority of review
 * comments sit, so an unrecognized value lands a thread in the right place far more often than not.
 */
export function resolveAnchorSide(positionContext: string | undefined): AnchorSide {
    return positionContext !== undefined && positionContext.trim().toLowerCase() === 'leftbuffer'
        ? 'base'
        : 'reviewed';
}

/** A thread positioned against the rendered diff. */
export interface AnchoredThread {
    readonly thread: ReviewThread;
    readonly side: AnchorSide;
    readonly startLine: number;
    /** Inclusive, so a single-line comment has `startLine === endLine`. */
    readonly endLine: number;
    /**
     * Row the thread is rendered beneath, or undefined when the anchor no longer exists in either
     * version -- in which case the viewer shows the thread above the diff instead of dropping it.
     */
    readonly rowIndex: number | undefined;
}

/**
 * Finds the row a thread should hang from.
 *
 * The end of the range is preferred so a thread covering a block appears after the block rather than
 * splitting it, and the search walks back through the range because a partially rewritten block can
 * leave the first of its lines present and the last gone.
 */
function findAnchorRow(
    rows: readonly DiffRow[],
    side: AnchorSide,
    startLine: number,
    endLine: number): number | undefined {
    for (let lineNumber = endLine; lineNumber >= startLine; lineNumber--) {
        const index = findRowIndex(rows, side, lineNumber);
        if (index !== undefined) {
            return index;
        }
    }
    return undefined;
}

/** Positions every anchored thread against the rendered diff, in render order. */
export function anchorThreads(
    threads: readonly ReviewThread[],
    rows: readonly DiffRow[]): readonly AnchoredThread[] {
    const anchored: AnchoredThread[] = [];

    for (const thread of threads) {
        const position = thread.position;
        if (position === undefined) {
            continue;
        }

        const side = resolveAnchorSide(position.positionContext);
        const startLine = position.startLine;
        const endLine = inclusiveEndLine(position);

        anchored.push({
            thread,
            side,
            startLine,
            endLine,
            rowIndex: findAnchorRow(rows, side, startLine, endLine),
        });
    }

    return anchored;
}

/** Groups anchored threads by the row they hang from, so a row can render all of its threads at once. */
export function groupByRow(
    anchored: readonly AnchoredThread[]): ReadonlyMap<number, readonly AnchoredThread[]> {
    const byRow = new Map<number, AnchoredThread[]>();
    for (const entry of anchored) {
        if (entry.rowIndex === undefined) {
            continue;
        }
        const existing = byRow.get(entry.rowIndex);
        if (existing === undefined) {
            byRow.set(entry.rowIndex, [entry]);
        } else {
            existing.push(entry);
        }
    }
    return byRow;
}
