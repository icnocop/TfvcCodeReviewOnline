/**
 * Line diff between the base version of a file and the version under review.
 *
 * Written in-house rather than pulled from npm. Every JavaScript diff library is a CommonJS or ESM
 * runtime dependency, and the extension's bundle is a single AMD file emitted by tsc with no
 * bundler in the pipeline, so adding one would mean adding webpack. A line-level longest common
 * subsequence is about sixty lines and is directly unit-testable, which is a better trade here.
 */

/** What happened to a line between the two versions. */
export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
    readonly kind: DiffLineKind;
    /** 1-based line number on the base side; undefined for an added line. */
    readonly baseLine: number | undefined;
    /** 1-based line number on the reviewed side; undefined for a removed line. */
    readonly reviewedLine: number | undefined;
    readonly text: string;
}

/**
 * Ceiling on the size of the dynamic-programming table, in cells.
 *
 * The table is a Uint32Array, so this caps it at 8 MB. Common prefixes and suffixes are stripped
 * before the table is built, so a normal review never approaches this; it exists for the case of two
 * genuinely unrelated files of a few thousand lines each, where an unbounded table would freeze the
 * tab. Past the ceiling the whole changed region is reported as a replacement, which is accurate,
 * just less finely resolved.
 */
const MAXIMUM_TABLE_CELLS = 2000000;

/** Splits file text into lines, tolerating CRLF, LF, or CR and a UTF-8 byte order mark. */
export function splitLines(text: string): readonly string[] {
    const withoutByteOrderMark = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const lines = withoutByteOrderMark.split(/\r\n|\n|\r/);

    // A file ending in a newline splits into a final empty element that is not a line of the file.
    // Without this, every well-formed file appears to have one more line than it has.
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }

    return lines;
}

export interface DiffOptions {
    /**
     * Treat lines that differ only in leading or trailing whitespace as unchanged.
     *
     * Re-indenting a block, or an editor stripping trailing spaces on save, otherwise marks every
     * line it touched as changed and buries the edit that was actually made. The comparison ignores
     * the whitespace; the text shown keeps it, because that is what is in the file.
     */
    readonly ignoreWhitespace?: boolean;
}

function comparisonKeys(
    lines: readonly string[],
    options: DiffOptions | undefined): readonly string[] {
    return options?.ignoreWhitespace ? lines.map((line) => line.trim()) : lines;
}

/**
 * Indexes of lines common to both sides, as `[baseIndex, reviewedIndex]` pairs in ascending order.
 */
function longestCommonSubsequence(
    base: readonly string[],
    reviewed: readonly string[]): readonly (readonly [number, number])[] {
    const baseLength = base.length;
    const reviewedLength = reviewed.length;
    const width = reviewedLength + 1;

    // table[i][j] = length of the longest common subsequence of base[i..] and reviewed[j..].
    const table = new Uint32Array((baseLength + 1) * width);
    for (let i = baseLength - 1; i >= 0; i--) {
        for (let j = reviewedLength - 1; j >= 0; j--) {
            table[i * width + j] = base[i] === reviewed[j]
                ? table[(i + 1) * width + (j + 1)] + 1
                : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
        }
    }

    const pairs: (readonly [number, number])[] = [];
    let i = 0;
    let j = 0;
    while (i < baseLength && j < reviewedLength) {
        if (base[i] === reviewed[j]) {
            pairs.push([i, j]);
            i++;
            j++;
        } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
            i++;
        } else {
            j++;
        }
    }

    return pairs;
}

/** Diffs two arrays of lines. Exposed separately from `diffLines` so tests can be explicit. */
export function diffLineArrays(
    base: readonly string[],
    reviewed: readonly string[],
    options?: DiffOptions): readonly DiffLine[] {
    // Compared through these, emitted from the originals: whether two lines count as the same is a
    // question for the options, but what the reader is shown is whatever the file holds.
    const baseKeys = comparisonKeys(base, options);
    const reviewedKeys = comparisonKeys(reviewed, options);

    const lines: DiffLine[] = [];
    let baseLine = 1;
    let reviewedLine = 1;

    const emitContext = (text: string): void => {
        lines.push({ kind: 'context', baseLine: baseLine++, reviewedLine: reviewedLine++, text });
    };
    const emitRemoved = (text: string): void => {
        lines.push({ kind: 'removed', baseLine: baseLine++, reviewedLine: undefined, text });
    };
    const emitAdded = (text: string): void => {
        lines.push({ kind: 'added', baseLine: undefined, reviewedLine: reviewedLine++, text });
    };

    // Trimming the identical head and tail first is what keeps the table small: an edit to one
    // method in a long file leaves only the surrounding few lines for the expensive step.
    let prefix = 0;
    while (prefix < base.length
        && prefix < reviewed.length
        && baseKeys[prefix] === reviewedKeys[prefix]) {
        prefix++;
    }

    let suffix = 0;
    while (suffix < base.length - prefix
        && suffix < reviewed.length - prefix
        && baseKeys[base.length - 1 - suffix] === reviewedKeys[reviewed.length - 1 - suffix]) {
        suffix++;
    }

    for (let i = 0; i < prefix; i++) {
        emitContext(base[i]);
    }

    const baseMiddle = base.slice(prefix, base.length - suffix);
    const reviewedMiddle = reviewed.slice(prefix, reviewed.length - suffix);
    const baseMiddleKeys = baseKeys.slice(prefix, base.length - suffix);
    const reviewedMiddleKeys = reviewedKeys.slice(prefix, reviewed.length - suffix);

    if ((baseMiddle.length + 1) * (reviewedMiddle.length + 1) > MAXIMUM_TABLE_CELLS) {
        // Too large to align line by line. Reporting the region as removed-then-added is still a
        // correct diff, and both versions remain readable, which matters more than minimality.
        for (const text of baseMiddle) {
            emitRemoved(text);
        }
        for (const text of reviewedMiddle) {
            emitAdded(text);
        }
    } else {
        let baseIndex = 0;
        let reviewedIndex = 0;
        const matches = longestCommonSubsequence(baseMiddleKeys, reviewedMiddleKeys);
        for (const [matchedBase, matchedReviewed] of matches) {
            // Removals before additions, so a changed line reads as the old value then the new one.
            while (baseIndex < matchedBase) {
                emitRemoved(baseMiddle[baseIndex++]);
            }
            while (reviewedIndex < matchedReviewed) {
                emitAdded(reviewedMiddle[reviewedIndex++]);
            }
            emitContext(baseMiddle[matchedBase]);
            baseIndex++;
            reviewedIndex++;
        }
        while (baseIndex < baseMiddle.length) {
            emitRemoved(baseMiddle[baseIndex++]);
        }
        while (reviewedIndex < reviewedMiddle.length) {
            emitAdded(reviewedMiddle[reviewedIndex++]);
        }
    }

    for (let i = base.length - suffix; i < base.length; i++) {
        emitContext(base[i]);
    }

    return lines;
}

/**
 * Diffs the text of two versions of a file.
 *
 * Passing an empty string for one side is how an add or a delete is expressed: the result is then
 * entirely added or entirely removed lines, with no special case anywhere else.
 */
export function diffLines(
    baseText: string,
    reviewedText: string,
    options?: DiffOptions): readonly DiffLine[] {
    return diffLineArrays(splitLines(baseText), splitLines(reviewedText), options);
}

/**
 * Reconstructs one side of the file from the diff.
 *
 * The diff already carries every line of both versions -- the base text is every line that was not
 * added, the reviewed text every line that was not removed -- so the character offsets a new comment
 * needs can be computed without fetching either version a second time.
 */
export function sideLines(
    lines: readonly DiffLine[],
    side: 'base' | 'reviewed'): readonly string[] {
    const excluded: DiffLineKind = side === 'base' ? 'added' : 'removed';
    const result: string[] = [];
    for (const line of lines) {
        if (line.kind !== excluded) {
            result.push(line.text);
        }
    }
    return result;
}

/**
 * Length of the longest line on one side, in characters.
 *
 * Used to work out how wide the table has to be for lines that are not wrapped. Written as a loop
 * rather than `Math.max(...lengths)`, because spreading an array of many thousands of lines as
 * arguments overflows the call stack on exactly the large files that need this most.
 */
export function longestLineLength(
    lines: readonly DiffLine[],
    side: 'base' | 'reviewed'): number {
    let longest = 0;
    for (const line of sideLines(lines, side)) {
        if (line.length > longest) {
            longest = line.length;
        }
    }
    return longest;
}

/**
 * Character offset of the start of a 1-based line, counting the terminators between them.
 *
 * This is what Visual Studio records in `Position.StartCharPosition` and `EndCharPosition`, and
 * writing the same values is what keeps a comment written here indistinguishable from one it wrote.
 * CRLF is assumed, because that is what the TFVC item routes return and what the offsets VS records
 * are consistent with.
 */
export function offsetOfLineStart(lines: readonly string[], lineNumber: number): number {
    const LINE_TERMINATOR_LENGTH = 2;
    let offset = 0;
    for (let index = 0; index < lineNumber - 1 && index < lines.length; index++) {
        offset += lines[index].length + LINE_TERMINATOR_LENGTH;
    }
    return offset;
}
