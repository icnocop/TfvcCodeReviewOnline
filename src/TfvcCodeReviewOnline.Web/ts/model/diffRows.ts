/**
 * Arranges a diff into rows, for either of the two ways of viewing it.
 *
 * Both views render the same `DiffLine[]`; they differ only in how those lines are laid out. Inline
 * puts one line per row, in order. Side by side pairs a removed line with the added line that
 * replaced it, so the old and new text sit level with each other.
 *
 * The pairing is the whole reason this is a separate, testable step. A change of three lines into
 * five is not a sequence of five rows, it is five rows where the first three carry both a left and a
 * right cell and the last two carry only a right one -- and getting that wrong misaligns everything
 * below it. Row *indexes* matter too, because that is what a thread anchors to.
 */

import type { DiffLine } from './diff';

/**
 * How the diff is laid out.
 *
 * `base` and `reviewed` show one version on its own, the way Visual Studio's compare window offers
 * left-only and right-only. They are worth having for reading a file as it stands rather than as it
 * changed -- and for the case the diff makes hardest, a heavily rewritten file where the interleaved
 * view is mostly noise.
 */
export type DiffViewMode = 'inline' | 'sideBySide' | 'base' | 'reviewed';

/** Columns each layout renders, which is what a full-width row has to span. */
export function columnCount(mode: DiffViewMode): number {
    // Two gutters + marker + code, or two gutter-and-marker pairs with a code column each.
    return mode === 'sideBySide' ? 6 : mode === 'inline' ? 4 : 3;
}

/** True when the layout shows only one of the two versions. */
export function isSingleSided(mode: DiffViewMode): mode is 'base' | 'reviewed' {
    return mode === 'base' || mode === 'reviewed';
}

/**
 * One rendered row.
 *
 * In inline mode exactly one of the two is set, and `line` is that one. In side-by-side mode either
 * or both may be set.
 */
export interface DiffRow {
    /** Base-side cell, if this row shows one. */
    readonly base: DiffLine | undefined;
    /** Reviewed-side cell, if this row shows one. */
    readonly reviewed: DiffLine | undefined;
}

/** One row per line, in the order the diff produced them. */
export function toInlineRows(lines: readonly DiffLine[]): readonly DiffRow[] {
    return lines.map((line) => line.kind === 'removed'
        ? { base: line, reviewed: undefined }
        : line.kind === 'added'
            ? { base: undefined, reviewed: line }
            // A context line is the same text on both sides, and shows in both columns.
            : { base: line, reviewed: line });
}

/** Rows with removed lines paired against the added lines that replaced them. */
export function toSideBySideRows(lines: readonly DiffLine[]): readonly DiffRow[] {
    const rows: DiffRow[] = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index];

        if (line.kind === 'context') {
            rows.push({ base: line, reviewed: line });
            index++;
            continue;
        }

        // Collect the whole change block -- every consecutive removal, then every consecutive
        // addition -- before emitting anything, because the pairing needs both counts.
        const removed: DiffLine[] = [];
        while (index < lines.length && lines[index].kind === 'removed') {
            removed.push(lines[index]);
            index++;
        }
        const added: DiffLine[] = [];
        while (index < lines.length && lines[index].kind === 'added') {
            added.push(lines[index]);
            index++;
        }

        for (let offset = 0; offset < Math.max(removed.length, added.length); offset++) {
            rows.push({
                base: offset < removed.length ? removed[offset] : undefined,
                reviewed: offset < added.length ? added[offset] : undefined,
            });
        }
    }

    return rows;
}

/**
 * One version on its own, as it stands.
 *
 * Lines the other side introduced are dropped rather than shown as gaps: the point of this layout is
 * to read the file, and a file does not have holes in it.
 */
export function toSingleSideRows(
    lines: readonly DiffLine[],
    side: 'base' | 'reviewed'): readonly DiffRow[] {
    const excluded = side === 'base' ? 'added' : 'removed';
    const rows: DiffRow[] = [];

    for (const line of lines) {
        if (line.kind === excluded) {
            continue;
        }
        rows.push(side === 'base'
            ? { base: line, reviewed: undefined }
            : { base: undefined, reviewed: line });
    }

    return rows;
}

export function toRows(lines: readonly DiffLine[], mode: DiffViewMode): readonly DiffRow[] {
    switch (mode) {
        case 'inline':
            return toInlineRows(lines);
        case 'sideBySide':
            return toSideBySideRows(lines);
        default:
            return toSingleSideRows(lines, mode);
    }
}

/** The line number a row shows on one side, or undefined when that side has no cell in this row. */
export function rowLineNumber(row: DiffRow, side: 'base' | 'reviewed'): number | undefined {
    return side === 'base' ? row.base?.baseLine : row.reviewed?.reviewedLine;
}

/**
 * Index of the row showing a given line of one side.
 *
 * Replaces looking the line up in the flat `DiffLine[]`: in side-by-side mode a row can carry two
 * lines at once, so the index of a line among the lines is not the index of its row.
 */
export function findRowIndex(
    rows: readonly DiffRow[],
    side: 'base' | 'reviewed',
    lineNumber: number): number | undefined {
    for (let index = 0; index < rows.length; index++) {
        if (rowLineNumber(rows[index], side) === lineNumber) {
            return index;
        }
    }
    return undefined;
}

/** True when a row shows nothing but unchanged text, and so may be collapsed away. */
export function isUnchangedRow(row: DiffRow): boolean {
    return (row.base === undefined || row.base.kind === 'context')
        && (row.reviewed === undefined || row.reviewed.kind === 'context');
}

/** A run of rows, either shown or hidden behind an expander. */
export interface DiffRowHunk {
    readonly collapsed: boolean;
    readonly rows: readonly DiffRow[];
}

/**
 * Hides long runs of unchanged rows.
 *
 * A shelveset can touch three lines of a two-thousand-line file, and rendering the other 1,997 as
 * context buries the review. Changed rows are always kept, as are the rows named in
 * `alwaysVisibleIndexes` -- which is how a comment anchored deep in an untouched region stays
 * visible along with the code it refers to.
 */
export function collapseUnchangedRows(
    rows: readonly DiffRow[],
    contextRowCount: number,
    alwaysVisibleIndexes: ReadonlySet<number> = new Set<number>()): readonly DiffRowHunk[] {
    const visible = new Array<boolean>(rows.length).fill(false);

    for (let index = 0; index < rows.length; index++) {
        if (isUnchangedRow(rows[index]) && !alwaysVisibleIndexes.has(index)) {
            continue;
        }
        const from = Math.max(0, index - contextRowCount);
        const to = Math.min(rows.length - 1, index + contextRowCount);
        for (let neighbor = from; neighbor <= to; neighbor++) {
            visible[neighbor] = true;
        }
    }

    const hunks: DiffRowHunk[] = [];
    let index = 0;
    while (index < rows.length) {
        const collapsed = !visible[index];
        const start = index;
        while (index < rows.length && !visible[index] === collapsed) {
            index++;
        }
        hunks.push({ collapsed, rows: rows.slice(start, index) });
    }

    return hunks;
}
