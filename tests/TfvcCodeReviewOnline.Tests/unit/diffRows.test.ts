import { describe, expect, it } from 'vitest';

import { diffLineArrays } from '../../../src/TfvcCodeReviewOnline.Web/ts/model/diff';
import {
    collapseUnchangedRows,
    columnCount,
    findRowIndex,
    isSingleSided,
    isUnchangedRow,
    rowLineNumber,
    toInlineRows,
    toRows,
    toSideBySideRows,
    toSingleSideRows,
    type DiffRow,
} from '../../../src/TfvcCodeReviewOnline.Web/ts/model/diffRows';

/** Compact rendering of a row pair, so an expectation reads like the layout it describes. */
function render(rows: readonly DiffRow[]): readonly string[] {
    return rows.map((row) => `${row.base?.text ?? ''}|${row.reviewed?.text ?? ''}`);
}

describe('toInlineRows', () => {
    it('gives a context line both sides, so either line number finds it', () => {
        const [row] = toInlineRows(diffLineArrays(['a'], ['a']));

        expect(row.base?.text).toBe('a');
        expect(row.reviewed?.text).toBe('a');
    });

    it('gives a removed line only a base side and an added line only a reviewed side', () => {
        const rows = toInlineRows(diffLineArrays(['a'], ['A']));

        expect(render(rows)).toEqual(['a|', '|A']);
    });

    it('keeps one row per line, in diff order', () => {
        const lines = diffLineArrays(['a', 'b', 'c'], ['a', 'B', 'c']);

        expect(toInlineRows(lines)).toHaveLength(lines.length);
    });
});

describe('toSideBySideRows', () => {
    it('pairs a removed line against the added line that replaced it', () => {
        expect(render(toSideBySideRows(diffLineArrays(['a', 'b'], ['a', 'B'])))).toEqual([
            'a|a',
            'b|B',
        ]);
    });

    it('leaves the shorter side empty when a block grows', () => {
        // Three lines becoming five is five rows, the last two with nothing on the left. Getting
        // this wrong misaligns every row below it.
        expect(render(toSideBySideRows(
            diffLineArrays(['x', 'a', 'b', 'c', 'z'], ['x', 'A', 'B', 'C', 'D', 'E', 'z'])))).toEqual([
            'x|x',
            'a|A',
            'b|B',
            'c|C',
            '|D',
            '|E',
            'z|z',
        ]);
    });

    it('leaves the shorter side empty when a block shrinks', () => {
        expect(render(toSideBySideRows(
            diffLineArrays(['x', 'a', 'b', 'c', 'z'], ['x', 'A', 'z'])))).toEqual([
            'x|x',
            'a|A',
            'b|',
            'c|',
            'z|z',
        ]);
    });

    it('renders a pure insertion with nothing on the left', () => {
        expect(render(toSideBySideRows(diffLineArrays(['a', 'c'], ['a', 'b', 'c'])))).toEqual([
            'a|a',
            '|b',
            'c|c',
        ]);
    });

    it('keeps consecutive change blocks separate', () => {
        expect(render(toSideBySideRows(
            diffLineArrays(['a', 'b', 'c', 'd'], ['A', 'b', 'C', 'd'])))).toEqual([
            'a|A',
            'b|b',
            'c|C',
            'd|d',
        ]);
    });
});

describe('toRows', () => {
    it('selects the layout by mode', () => {
        const lines = diffLineArrays(['a'], ['A']);

        expect(toRows(lines, 'inline')).toHaveLength(2);
        expect(toRows(lines, 'sideBySide')).toHaveLength(1);
    });
});

describe('rowLineNumber and findRowIndex', () => {
    const lines = diffLineArrays(['one', 'two', 'three'], ['one', 'TWO', 'three']);

    it('finds a line by side in the inline layout', () => {
        const rows = toInlineRows(lines);

        // one|one, two|--, --|TWO, three|three
        expect(findRowIndex(rows, 'base', 2)).toBe(1);
        expect(findRowIndex(rows, 'reviewed', 2)).toBe(2);
    });

    it('finds a line by side in the side-by-side layout, where one row carries two', () => {
        // This is why anchoring works on rows rather than on lines: here both line 2s share a row,
        // so the index of a line among the lines is not the index of its row.
        const rows = toSideBySideRows(lines);

        expect(findRowIndex(rows, 'base', 2)).toBe(1);
        expect(findRowIndex(rows, 'reviewed', 2)).toBe(1);
    });

    it('reports a line the side does not have', () => {
        expect(findRowIndex(toInlineRows(lines), 'reviewed', 99)).toBeUndefined();
    });

    it('reads the line number a row shows on each side', () => {
        const rows = toSideBySideRows(lines);

        expect(rowLineNumber(rows[0], 'base')).toBe(1);
        expect(rowLineNumber(rows[0], 'reviewed')).toBe(1);
    });
});

describe('isUnchangedRow', () => {
    it('recognizes a row carrying only context', () => {
        expect(isUnchangedRow(toInlineRows(diffLineArrays(['a'], ['a']))[0])).toBe(true);
    });

    it('recognizes a row carrying a change on either side', () => {
        const rows = toSideBySideRows(diffLineArrays(['a'], ['A']));

        expect(isUnchangedRow(rows[0])).toBe(false);
    });
});

describe('collapseUnchangedRows', () => {
    const rows = toInlineRows(diffLineArrays(
        Array.from({ length: 30 }, (_, index) => `line ${index + 1}`),
        Array.from({ length: 30 }, (_, index) => (index === 14 ? 'changed' : `line ${index + 1}`))));

    it('hides unchanged runs and keeps context around the change', () => {
        const hunks = collapseUnchangedRows(rows, 3);

        expect(hunks.map((hunk) => hunk.collapsed)).toEqual([true, false, true]);
        const visible = hunks[1].rows;
        expect(visible.filter((row) => !isUnchangedRow(row))).toHaveLength(2);
        // Three unchanged rows either side of the removed row and the added row.
        expect(visible).toHaveLength(3 + 2 + 3);
    });

    it('keeps rows it is told to keep, so a comment is never hidden behind an expander', () => {
        const hunks = collapseUnchangedRows(rows, 0, new Set([0]));

        expect(hunks[0].collapsed).toBe(false);
        expect(hunks[0].rows[0].base?.baseLine).toBe(1);
    });

    it('accounts for every row exactly once, in order', () => {
        const hunks = collapseUnchangedRows(rows, 3);
        const rejoined = hunks.reduce<DiffRow[]>((all, hunk) => all.concat(hunk.rows), []);

        expect(rejoined).toEqual(rows);
    });

    it('collapses nothing when everything is within the context window', () => {
        const short = toInlineRows(diffLineArrays(['a', 'b'], ['a', 'B']));

        expect(collapseUnchangedRows(short, 3).map((hunk) => hunk.collapsed)).toEqual([false]);
    });
});

describe('toSingleSideRows', () => {
    const lines = diffLineArrays(['one', 'two', 'three'], ['one', 'TWO', 'three']);

    it('shows the base version as it stands, without gaps for the other side', () => {
        // The point of this layout is to read the file, and a file does not have holes in it.
        const rows = toSingleSideRows(lines, 'base');

        expect(rows.map((row) => row.base?.text)).toEqual(['one', 'two', 'three']);
        expect(rows.every((row) => row.reviewed === undefined)).toBe(true);
    });

    it('shows the reviewed version as it stands', () => {
        const rows = toSingleSideRows(lines, 'reviewed');

        expect(rows.map((row) => row.reviewed?.text)).toEqual(['one', 'TWO', 'three']);
        expect(rows.every((row) => row.base === undefined)).toBe(true);
    });

    it('is selected by the matching view mode', () => {
        expect(toRows(lines, 'base')).toEqual(toSingleSideRows(lines, 'base'));
        expect(toRows(lines, 'reviewed')).toEqual(toSingleSideRows(lines, 'reviewed'));
    });

    it('lets a line still be found by its number on the side being shown', () => {
        expect(findRowIndex(toSingleSideRows(lines, 'base'), 'base', 3)).toBe(2);
    });
});

describe('columnCount and isSingleSided', () => {
    it('counts the columns each layout renders', () => {
        // Each version carries its own line numbers and change marker, as the built-in
        // shelveset view does. There is no shared column at the left of the row: the comment
        // button lives in the gutter of whichever side is being pointed at.
        expect(columnCount('inline')).toBe(4);
        expect(columnCount('sideBySide')).toBe(6);
        expect(columnCount('base')).toBe(3);
        expect(columnCount('reviewed')).toBe(3);
    });

    it('recognizes the layouts that show one version', () => {
        expect(isSingleSided('base')).toBe(true);
        expect(isSingleSided('reviewed')).toBe(true);
        expect(isSingleSided('inline')).toBe(false);
        expect(isSingleSided('sideBySide')).toBe(false);
    });
});
