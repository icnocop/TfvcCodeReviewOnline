import { describe, expect, it } from 'vitest';

import { diffLineArrays } from '../../../src/TfvcCodeReviewOnline.Web/ts/model/diff';
import {
    toInlineRows,
    toSideBySideRows,
} from '../../../src/TfvcCodeReviewOnline.Web/ts/model/diffRows';
import {
    anchorThreads,
    groupByRow,
    inclusiveEndLine,
    resolveAnchorSide,
} from '../../../src/TfvcCodeReviewOnline.Web/ts/model/lineAnchor';
import { position, thread } from './support/reviewFixtures';

const LINES = diffLineArrays(['one', 'two', 'three', 'four'], ['one', 'TWO', 'three', 'four']);

// one|one, two|--, --|TWO, three|three, four|four
const ROWS = toInlineRows(LINES);

describe('inclusiveEndLine', () => {
    it('treats an end at the start of a line as exclusive', () => {
        // Visual Studio records a comment on line 19 alone as StartLine 19, EndLine 20, EndColumn 1:
        // the selection runs to the first character of line 20 without including any of it.
        // Verified by writing a thread with EndLine 11 and seeing it render on line 10.
        expect(inclusiveEndLine(position({ startLine: 19, endLine: 20, endColumn: 1 }))).toBe(19);
    });

    it('keeps an end that reaches into the last line', () => {
        expect(inclusiveEndLine(position({ startLine: 19, endLine: 20, endColumn: 7 }))).toBe(20);
    });

    it('never moves a single-line anchor', () => {
        expect(inclusiveEndLine(position({ startLine: 19, endLine: 19, endColumn: 1 }))).toBe(19);
    });

    it('leaves the end alone when the column is unknown', () => {
        // No evidence either way, and shifting the anchor on a guess is worse than leaving it where
        // the service recorded it.
        expect(inclusiveEndLine(position({ startLine: 19, endLine: 20, endColumn: undefined })))
            .toBe(20);
    });

    it('tolerates an end line before the start line', () => {
        expect(inclusiveEndLine(position({ startLine: 3, endLine: 1, endColumn: 1 }))).toBe(3);
    });
});

describe('resolveAnchorSide', () => {
    it('reads LeftBuffer as the base version', () => {
        expect(resolveAnchorSide('LeftBuffer')).toBe('base');
        expect(resolveAnchorSide(' leftbuffer ')).toBe('base');
    });

    it('reads anything else, including nothing at all, as the reviewed version', () => {
        // Almost every review comment is on the reviewed side, so this default puts an unrecognized
        // value in the right place far more often than not.
        expect(resolveAnchorSide('RightBuffer')).toBe('reviewed');
        expect(resolveAnchorSide(undefined)).toBe('reviewed');
        expect(resolveAnchorSide('somethingElse')).toBe('reviewed');
    });
});

describe('anchorThreads', () => {
    it('hangs a thread from the line it names', () => {
        const [anchored] = anchorThreads(
            [thread({ position: position({ startLine: 3, endLine: 3 }) })], ROWS);

        expect(anchored.side).toBe('reviewed');
        expect(anchored.rowIndex).toBe(3);
    });

    it('hangs a multi-line thread from the end of its range', () => {
        // A thread covering a block reads better after the block than in the middle of it.
        const [anchored] = anchorThreads(
            [thread({ position: position({ startLine: 1, endLine: 3 }) })], ROWS);

        expect(anchored.rowIndex).toBe(3);
        expect(anchored.startLine).toBe(1);
        expect(anchored.endLine).toBe(3);
    });

    it('reports the inclusive end, not the exclusive one the service records', () => {
        const [anchored] = anchorThreads(
            [thread({ position: position({ startLine: 3, endLine: 4, endColumn: 1 }) })], ROWS);

        expect(anchored.endLine).toBe(3);
        expect(anchored.rowIndex).toBe(3);
    });

    it('walks back through the range when the last line of it is gone', () => {
        const shortened = toInlineRows(diffLineArrays(['one', 'two', 'three'], ['one']));
        const [anchored] = anchorThreads(
            [thread({ position: position({ startLine: 1, endLine: 3 }) })], shortened);

        // Reviewed line 3 no longer exists, but line 1 does.
        expect(anchored.rowIndex).toBe(0);
    });

    it('reports a thread whose lines are gone rather than attaching it to the wrong code', () => {
        const [anchored] = anchorThreads(
            [thread({ position: position({ startLine: 900, endLine: 900 }) })], ROWS);

        expect(anchored.rowIndex).toBeUndefined();
        expect(anchored.startLine).toBe(900);
    });

    it('anchors a base-side thread to the removed row', () => {
        const [anchored] = anchorThreads([
            thread({ position: position({ startLine: 2, endLine: 2, positionContext: 'LeftBuffer' }) }),
        ], ROWS);

        expect(anchored.side).toBe('base');
        expect(anchored.rowIndex).toBe(1);
    });

    it('anchors against the side-by-side layout, where a row carries both sides', () => {
        const rows = toSideBySideRows(LINES);
        const [base] = anchorThreads([
            thread({ position: position({ startLine: 2, endLine: 2, positionContext: 'LeftBuffer' }) }),
        ], rows);
        const [reviewed] = anchorThreads([
            thread({ position: position({ startLine: 2, endLine: 2, positionContext: 'RightBuffer' }) }),
        ], rows);

        // Both line 2s share row 1 here, unlike inline where they are rows 1 and 2.
        expect(base.rowIndex).toBe(1);
        expect(reviewed.rowIndex).toBe(1);
    });

    it('skips a thread with no position at all', () => {
        expect(anchorThreads([thread({ position: undefined })], ROWS)).toEqual([]);
    });
});

describe('groupByRow', () => {
    it('collects every thread that hangs from the same row', () => {
        const anchored = anchorThreads([
            thread({ id: 1, position: position({ startLine: 3, endLine: 3 }) }),
            thread({ id: 2, position: position({ startLine: 3, endLine: 3 }) }),
            thread({ id: 3, position: position({ startLine: 4, endLine: 4 }) }),
        ], ROWS);

        const byRow = groupByRow(anchored);

        expect(byRow.get(3)?.map((entry) => entry.thread.id)).toEqual([1, 2]);
        expect(byRow.get(4)?.map((entry) => entry.thread.id)).toEqual([3]);
    });

    it('leaves out threads that could not be anchored', () => {
        const anchored = anchorThreads(
            [thread({ position: position({ startLine: 900, endLine: 900 }) })], ROWS);

        expect(groupByRow(anchored).size).toBe(0);
    });
});
