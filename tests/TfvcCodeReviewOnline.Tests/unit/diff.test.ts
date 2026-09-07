import { describe, expect, it } from 'vitest';

import {
    diffLineArrays,
    diffLines,
    longestLineLength,
    offsetOfLineStart,
    sideLines,
    splitLines,
    type DiffLine,
} from '../../../src/TfvcCodeReviewOnline.Web/ts/model/diff';

/** Compact rendering of a diff, so an expectation reads like the diff it describes. */
function render(lines: readonly DiffLine[]): readonly string[] {
    return lines.map((line) => {
        const marker = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
        const base = line.baseLine === undefined ? '' : String(line.baseLine);
        const reviewed = line.reviewedLine === undefined ? '' : String(line.reviewedLine);
        return `${base}|${reviewed}|${marker}${line.text}`;
    });
}

describe('splitLines', () => {
    it('accepts any of the three line terminators', () => {
        expect(splitLines('a\r\nb\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
    });

    it('does not invent a line for a trailing newline', () => {
        // Nearly every source file ends with a newline. Counting the empty remainder as a line would
        // put every line anchor in every file off by one at the end.
        expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    });

    it('keeps a genuinely blank final line', () => {
        expect(splitLines('a\n\n')).toEqual(['a', '']);
    });

    it('strips a byte order mark so the first line is not corrupted', () => {
        expect(splitLines('\uFEFFusing System;')).toEqual(['using System;']);
    });

    it('treats empty content as no lines at all', () => {
        expect(splitLines('')).toEqual([]);
    });
});

describe('diffLineArrays', () => {
    it('reports identical files as all context, numbered on both sides', () => {
        expect(render(diffLineArrays(['a', 'b'], ['a', 'b']))).toEqual([
            '1|1| a',
            '2|2| b',
        ]);
    });

    it('numbers an insertion on the reviewed side only', () => {
        expect(render(diffLineArrays(['a', 'c'], ['a', 'b', 'c']))).toEqual([
            '1|1| a',
            '|2|+b',
            '2|3| c',
        ]);
    });

    it('numbers a deletion on the base side only', () => {
        expect(render(diffLineArrays(['a', 'b', 'c'], ['a', 'c']))).toEqual([
            '1|1| a',
            '2||-b',
            '3|2| c',
        ]);
    });

    it('puts the old value before the new one for a changed line', () => {
        // Removals ahead of additions is what makes a change read as "was this, is now that".
        expect(render(diffLineArrays(['a', 'b', 'c'], ['a', 'B', 'c']))).toEqual([
            '1|1| a',
            '2||-b',
            '|2|+B',
            '3|3| c',
        ]);
    });

    it('handles a change at the very start and the very end', () => {
        // The prefix and suffix trimming is an optimization, and an off-by-one in it would corrupt
        // exactly these two cases while leaving the middle of every file correct.
        expect(render(diffLineArrays(['a', 'b'], ['A', 'b']))).toEqual([
            '1||-a',
            '|1|+A',
            '2|2| b',
        ]);
        expect(render(diffLineArrays(['a', 'b'], ['a', 'B']))).toEqual([
            '1|1| a',
            '2||-b',
            '|2|+B',
        ]);
    });

    it('finds the common lines rather than replacing the whole block', () => {
        const lines = diffLineArrays(
            ['one', 'two', 'three', 'four', 'five'],
            ['one', 'two', 'inserted', 'three', 'five']);

        expect(render(lines)).toEqual([
            '1|1| one',
            '2|2| two',
            '|3|+inserted',
            '3|4| three',
            '4||-four',
            '5|5| five',
        ]);
    });

    it('preserves blank lines rather than collapsing them', () => {
        expect(render(diffLineArrays(['a', '', 'b'], ['a', '', 'b']))).toEqual([
            '1|1| a',
            '2|2| ',
            '3|3| b',
        ]);
    });
});

describe('diffLines', () => {
    it('renders an added file as entirely new lines', () => {
        expect(render(diffLines('', 'a\nb\n'))).toEqual([
            '|1|+a',
            '|2|+b',
        ]);
    });

    it('renders a deleted file as entirely removed lines', () => {
        expect(render(diffLines('a\nb\n', ''))).toEqual([
            '1||-a',
            '2||-b',
        ]);
    });

    it('ignores a difference in line terminators alone', () => {
        // A file rewritten with different line endings would otherwise show as wholly changed, which
        // would bury any real edit in it.
        expect(diffLines('a\r\nb\r\n', 'a\nb\n').every((line) => line.kind === 'context')).toBe(true);
    });

    it('produces no lines for two empty files', () => {
        expect(diffLines('', '')).toEqual([]);
    });
});

describe('sideLines', () => {
    const lines = diffLineArrays(['one', 'two', 'three'], ['one', 'TWO', 'three']);

    it('reconstructs the base version from the diff', () => {
        expect(sideLines(lines, 'base')).toEqual(['one', 'two', 'three']);
    });

    it('reconstructs the reviewed version from the diff', () => {
        // Both versions are recoverable from the diff alone, which is what lets a new comment
        // compute its character offsets without fetching either file a second time.
        expect(sideLines(lines, 'reviewed')).toEqual(['one', 'TWO', 'three']);
    });
});

describe('offsetOfLineStart', () => {
    const lines = ['abc', 'de', 'f'];

    it('counts the line terminators between lines', () => {
        // "abc\r\n" is five characters, so line 2 starts at 5 and line 3 at 5 + "de\r\n".
        expect(offsetOfLineStart(lines, 1)).toBe(0);
        expect(offsetOfLineStart(lines, 2)).toBe(5);
        expect(offsetOfLineStart(lines, 3)).toBe(9);
    });

    it('gives the offset just past the end for the line after the last', () => {
        // A comment's end offset is the start of the line after the range it covers, so this has to
        // be defined one past the end rather than clamped to it.
        expect(offsetOfLineStart(lines, 4)).toBe(12);
        expect(offsetOfLineStart(lines, 99)).toBe(12);
    });
});

describe('diffLines ignoring whitespace', () => {
    it('treats a re-indented line as unchanged', () => {
        // Re-indenting a block otherwise marks every line it touched as changed, burying whatever
        // edit was actually made in the noise.
        const lines = diffLines('    a\n', '        a\n', { ignoreWhitespace: true });

        expect(lines.map((line) => line.kind)).toEqual(['context']);
    });

    it('shows the text as it is in the file, not as it was compared', () => {
        const [line] = diffLines('    a\n', '        a\n', { ignoreWhitespace: true });

        expect(line.text).toBe('    a');
    });

    it('still reports a change to anything but whitespace', () => {
        const lines = diffLines('    a\n', '        b\n', { ignoreWhitespace: true });

        expect(lines.map((line) => line.kind)).toEqual(['removed', 'added']);
    });

    it('reports the same lines as changed when the option is off', () => {
        const lines = diffLines('    a\n', '        a\n');

        expect(lines.map((line) => line.kind)).toEqual(['removed', 'added']);
    });

    it('applies to the trimmed head and tail as well as the middle', () => {
        // The prefix and suffix are compared separately from the rest, so an option honored only in
        // the middle would give different answers at the edges of a file.
        const lines = diffLines('  a\nx\n  b\n', 'a\nY\nb\n', { ignoreWhitespace: true });

        expect(lines.map((line) => line.kind)).toEqual(['context', 'removed', 'added', 'context']);
    });
});

describe('longestLineLength', () => {
    const lines = diffLineArrays(['a', 'bbbbb'], ['a', 'ccc']);

    it('measures the longest line on each side separately', () => {
        // The two sides are sized independently, because with wrapping off each code column has to
        // be wide enough for its own content rather than for the other side's.
        expect(longestLineLength(lines, 'base')).toBe(5);
        expect(longestLineLength(lines, 'reviewed')).toBe(3);
    });

    it('reports nothing for a side with no lines', () => {
        expect(longestLineLength(diffLineArrays([], []), 'base')).toBe(0);
    });
});
