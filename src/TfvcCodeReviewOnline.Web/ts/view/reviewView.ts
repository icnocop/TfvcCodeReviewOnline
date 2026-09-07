/**
 * The reviewer's view: the review's own threads, then each file with its diff and the comments
 * anchored to the code they refer to, replies nested beneath them.
 *
 * Behaviors here that shape everything else:
 *
 * A comment is never dropped. If the diff cannot be built, if the shelveset has gone, if a thread's
 * anchor line no longer exists in either version -- the thread is still rendered, with an explanation
 * of why it is not beside the code. Losing a comment silently would be worse than any layout
 * problem, because the reader has no way to know it happened.
 *
 * Every file is open from the start, so the review reads as one document to scroll through. Their
 * contents are not all fetched at once, though: a review can span a hundred files, and two requests
 * apiece would be two hundred before the reader has looked at anything. Each file's content is
 * fetched as it nears the viewport, so the requests follow the reader down the page.
 *
 * Writing is optional. Without a `writer` the tab renders exactly as before, with no comment
 * affordances at all -- which is also what happens when the review has no thread to take its artifact
 * URI from, since the service refuses to create one without it.
 */

import { buildReplyTree } from '../clients/discussionRestClient';
import type {
    NewThreadAnchor,
    ReviewComment,
    ReviewCommentAuthor,
    ReviewThread,
} from '../clients/discussionRestClient';
import { isDelete } from '../clients/tfvcClient';
import type { ReviewedFile, ReviewedFileContent } from '../clients/tfvcClient';
import { CLOSED_STATUS_VALUES } from '../clients/workItemContext';
import type { ReviewClosure, ReviewContext, ReviewTarget } from '../clients/workItemContext';
import {
    longestLineLength,
    offsetOfLineStart,
    sideLines,
    type DiffLine,
} from '../model/diff';
import {
    collapseUnchangedRows,
    columnCount,
    isSingleSided,
    toRows,
    type DiffRow,
    type DiffViewMode,
} from '../model/diffRows';
import { buildFileDiff, describeFileChange, type FileDiffResult } from '../model/fileDiff';
import {
    anchorThreads,
    groupByRow,
    inclusiveEndLine,
    type AnchoredThread,
    type AnchorSide,
} from '../model/lineAnchor';
import {
    describeThreadAnchor,
    describeThreadStatus,
    findFileThreads,
    groupThreads,
    isThreadResolved,
    normalizeItemPath,
    visibleComments,
    type FileThreadGroup,
} from '../model/threadModel';
import { buildFileTree } from '../model/fileTree';
import { copyText } from './clipboard';
import { renderCommentForm } from './commentForm';
import { className, element, formatTimestamp, resetRoot, section } from './dom';
import { renderFileTree } from './fileTree';
import { arrowIcon, commentPlusIcon, externalLinkIcon, gearIcon } from './icons';
import { closeMenu, openMenu, type MenuGroup, type MenuItem } from './menu';
import {
    createColumnSplitter,
    createPaneLayout,
    DEFAULT_COLUMN_RATIO,
    DEFAULT_TREE_WIDTH,
    type PaneLayout,
    type RememberedPaneLayout,
} from './paneLayout';

/** Unchanged rows kept either side of a change or a comment. */
const CONTEXT_ROW_COUNT = 3;

/**
 * How far ahead of the viewport a file's content is fetched.
 *
 * Enough that scrolling at a normal pace finds the diff already there, without fetching the whole
 * review the moment it opens.
 */
const PRELOAD_MARGIN = '600px 0px';

const REPLY_INDENT_PIXELS = 22;

/** Cap on reply indentation, so a long back-and-forth does not squeeze the text off the right edge. */
const MAXIMUM_REPLY_DEPTH = 6;

const EXPANDED_GLYPH = '\u25be';
const COLLAPSED_GLYPH = '\u25b8';

/**
 * The caret on a control that opens a menu.
 *
 * Points down, always: it says "there is a list under this", not "this is folded up". The same glyph
 * as `EXPANDED_GLYPH` and deliberately named apart from it, because the two would otherwise look like
 * one thing and a later change to the expand/collapse pair would silently turn the caret sideways.
 */
const MENU_CARET_GLYPH = '\u25be';

/** What the view needs in order to write. Absent means a read-only tab. */
export interface ReviewWriter {
    /** Adds a reply to an existing thread, returning the comment the server created. */
    reply(threadId: number, parentCommentId: number, content: string): Promise<ReviewComment>;
    /** Starts a new thread, returning it as the server recorded it. */
    createThread(anchor: NewThreadAnchor | undefined, content: string): Promise<ReviewThread>;
}

/** What the view needs in order to close the review. Absent means the tab does not offer it. */
export interface ReviewCloser {
    /** Resolves once the work item has been saved as closed. */
    close(closure: ReviewClosure, comment: string): Promise<void>;
}

export interface ReviewViewModel {
    readonly reviewContext: ReviewContext;
    readonly threads: readonly ReviewThread[];
    readonly files: readonly ReviewedFile[];
    /** Set when the file list could not be read; the comments are still shown. */
    readonly filesError: string | undefined;
    /** Used to link the shelveset or changeset to version control. */
    readonly collectionUri?: string;
    readonly projectName?: string;
    /**
     * Fetches one file's two versions, called the first time that file comes into view.
     *
     * Content rather than a finished diff: whether whitespace counts as a change is a view
     * option, and re-diffing on that has to be possible without fetching the file again.
     */
    readonly loadFileContent: (file: ReviewedFile) => Promise<ReviewedFileContent>;
    readonly writer?: ReviewWriter;
    /**
     * Closes the review. Absent leaves the tab with no way to close one, which is what a host that
     * cannot write to the work item should supply.
     *
     * Offered only while the review is open: the work item type defines no transition out of
     * `Closed`, so a closed review stays closed and a control that appeared to reopen one would be
     * promising something the server will not do.
     */
    readonly closer?: ReviewCloser;
    readonly initialViewMode?: DiffViewMode;
    /** Called when the reader switches view, so the choice can be remembered for next time. */
    readonly onViewModeChanged?: (mode: DiffViewMode) => void;
    /** Width of the navigation pane, and whether it is closed, as the reader last left them. */
    readonly treePane?: RememberedPaneLayout;
    readonly onTreePaneChanged?: (layout: PaneLayout) => void;
    /** Whether long lines wrap. Defaults to wrapping, which is what the tab has always done. */
    readonly initialWordWrap?: boolean;
    readonly onWordWrapChanged?: (wrap: boolean) => void;
    /** Whether whitespace-only differences are hidden. Off by default. */
    readonly initialIgnoreWhitespace?: boolean;
    readonly onIgnoreWhitespaceChanged?: (ignore: boolean) => void;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function plural(count: number, singular: string): string {
    return count === 1 ? `${count} ${singular}` : `${count} ${singular}s`;
}

/**
 * Describes a thread count, mentioning unresolved threads only when that number says something the
 * total does not.
 *
 * On a TFVC collection every thread comes back as `active`: the Visual Studio code review page has
 * no per-thread resolve action, so nothing ever writes another status and the two counts are always
 * equal. Rendering "8 threads, 8 unresolved" is then the same number said twice, dressed up as
 * information. Where a thread genuinely is resolved the count reappears on its own.
 */
export function describeThreadCount(total: number, unresolved: number): string {
    return unresolved > 0 && unresolved < total
        ? `${plural(total, 'thread')}, ${unresolved} unresolved`
        : plural(total, 'thread');
}

/** Initials for an identity with no avatar, so every comment still has something in the gutter. */
export function initialsOf(displayName: string): string {
    const words = displayName.split(/[\s,]+/).filter((word) => word.length > 0);
    if (words.length === 0) {
        return '?';
    }
    const first = words[0].charAt(0);
    const last = words.length > 1 ? words[words.length - 1].charAt(0) : '';
    return (first + last).toUpperCase();
}

/**
 * The comment a reply should be parented to.
 *
 * Visual Studio parents every reply to the thread's root comment rather than to the one before it --
 * verified against its own threads, which read back as `id=2/parent=1  id=3/parent=1`. Matching that
 * keeps a thread flat here and in Visual Studio alike, instead of indenting each reply one step
 * further than the last.
 */
export function rootCommentId(thread: ReviewThread): number | undefined {
    const comments = visibleComments(thread);
    const root = comments.filter((comment) => comment.parentId === undefined)[0];
    return (root ?? comments[0])?.id;
}

function iconButton(label: string): HTMLButtonElement {
    const button = element('button', className('icon-button'));
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.appendChild(commentPlusIcon());
    return button;
}

function renderAvatar(author: ReviewCommentAuthor): HTMLElement {
    if (author.imageUrl) {
        const image = element('img', className('avatar'));
        image.src = author.imageUrl;
        // Decorative: the display name sits immediately beside it, so announcing the image as well
        // would just repeat the name to anyone using a screen reader.
        image.alt = '';
        return image;
    }
    return element(
        'span',
        `${className('avatar')} ${className('avatar--initials')}`,
        initialsOf(author.displayName));
}

function renderComment(comment: ReviewComment, depth: number): HTMLElement {
    const item = element('li', className('comment'));
    if (depth > 0) {
        item.classList.add(className('comment--reply'));
        item.style.marginLeft = `${Math.min(depth, MAXIMUM_REPLY_DEPTH) * REPLY_INDENT_PIXELS}px`;
    }

    const header = element('div', className('comment-header'));
    header.appendChild(renderAvatar(comment.author));
    header.appendChild(element('span', className('comment-author'), comment.author.displayName));

    const timestamp = element('span', className('comment-date'), formatTimestamp(comment.publishedDate));
    if (comment.publishedDate) {
        timestamp.title = comment.publishedDate;
    }
    header.appendChild(timestamp);
    item.appendChild(header);

    // Comment text carries meaningful line breaks, which the stylesheet preserves. It is written as
    // text, never as markup: see the note in ts/view/dom.ts.
    item.appendChild(element('div', className('comment-content'), comment.content));

    return item;
}

/** Renders one thread, its replies, and -- when writing is possible -- a way to add another. */
function renderThread(
    thread: ReviewThread,
    anchorLabel: string,
    writer: ReviewWriter | undefined): HTMLElement {
    const container = element('div', className('thread'));
    if (isThreadResolved(thread)) {
        container.classList.add(className('thread--resolved'));
    }

    const header = element('div', className('thread-header'));
    if (anchorLabel) {
        header.appendChild(element('span', className('thread-anchor'), anchorLabel));
    }
    const status = describeThreadStatus(thread);
    if (status) {
        header.appendChild(element('span', className('thread-status'), status));
    }
    if (header.childNodes.length > 0) {
        container.appendChild(header);
    }

    const comments = element('ol', className('comments'));
    for (const entry of buildReplyTree(visibleComments(thread))) {
        comments.appendChild(renderComment(entry.comment, entry.depth));
    }
    container.appendChild(comments);

    const parentId = rootCommentId(thread);
    if (writer !== undefined && parentId !== undefined) {
        container.appendChild(renderReplyAffordance(thread, parentId, comments, writer));
    }

    return container;
}

/** The Reply link, and the form it swaps itself for. */
function renderReplyAffordance(
    thread: ReviewThread,
    parentCommentId: number,
    comments: HTMLElement,
    writer: ReviewWriter): HTMLElement {
    const host = element('div', className('reply-host'));

    const open = element('button', className('link-button'), 'Reply');
    open.type = 'button';

    const showLink = (): void => {
        host.textContent = '';
        host.appendChild(open);
    };

    open.addEventListener('click', () => {
        host.textContent = '';
        host.appendChild(renderCommentForm({
            placeholder: 'Write a reply',
            submitLabel: 'Reply',
            onCancel: showLink,
            onSubmit: async (content) => {
                const created = await writer.reply(thread.id, parentCommentId, content);
                // Appended rather than reloaded: a reload would collapse every file the reader has
                // opened and lose their place in a long review.
                comments.appendChild(renderComment(created, created.parentId === undefined ? 0 : 1));
                showLink();
            },
        }));
    });

    showLink();
    return host;
}

function anchorLabelFor(entry: AnchoredThread): string {
    const range = describeThreadAnchor(entry.startLine, entry.endLine);
    return entry.side === 'base' ? `${range} (base version)` : range;
}

/** Label for a thread rendered away from the code, where the range alone would be ambiguous. */
function detachedAnchorLabelFor(thread: ReviewThread): string {
    const position = thread.position;
    if (position === undefined) {
        return '';
    }
    const range = describeThreadAnchor(position.startLine, inclusiveEndLine(position));
    return position.positionContext !== undefined
        && position.positionContext.trim().toLowerCase() === 'leftbuffer'
        ? `${range} (base version)`
        : range;
}

/**
 * States the diff table's column widths.
 *
 * This is not decoration. Under `table-layout: fixed` the browser takes its column widths from the
 * cells of the *first row*, and the first row of a diff that begins with hidden lines is a single
 * cell spanning every column -- so it divides the width into equal parts and leaves the code crushed
 * into the last one, behind absurdly wide line-number columns. A colgroup states the widths
 * independently of whatever the first row happens to be.
 */
interface DiffColumns {
    readonly group: HTMLElement;
    /**
     * The left code column in the side-by-side layout, whose width is the share the two versions
     * split between them. Undefined inline, where there is only one code column.
     */
    readonly leftCodeColumn: HTMLElement | undefined;
}

function renderDiffColumns(mode: DiffViewMode, ratio: number): DiffColumns {
    const group = element('colgroup');
    // The action gutter, then whatever precedes the final, unsized column.
    const widths = isSingleSided(mode)
        ? ['3.6em', '1.2em']
        : mode === 'inline'
            ? ['3.6em', '3.6em', '1.2em']
            : ['3.6em', '1.2em', `${ratio * 100}%`, '3.6em', '1.2em'];

    const columns: HTMLElement[] = [];
    for (const width of widths) {
        const column = element('col');
        column.style.width = width;
        columns.push(column);
        group.appendChild(column);
    }
    // The last column takes whatever remains.
    group.appendChild(element('col'));

    return { group, leftCodeColumn: mode === 'sideBySide' ? columns[2] : undefined };
}

function codeCell(line: DiffLine | undefined, side: AnchorSide): HTMLTableCellElement {
    const cell = element('td', className('code'));

    // The text sits in a span rather than straight in the cell so one column can be shifted
    // sideways on its own: a table cell cannot scroll, but its contents can be moved.
    cell.appendChild(element(
        'span', className('code-text'), line === undefined ? '' : line.text));

    if (line !== undefined) {
        const lineNumber = side === 'base' ? line.baseLine : line.reviewedLine;
        if (lineNumber !== undefined) {
            // Read back when a text selection is turned into a line range.
            cell.dataset.side = side;
            cell.dataset.line = String(lineNumber);
        }
        if (line.kind !== 'context') {
            cell.classList.add(className(`code--${line.kind}`));
        }
    } else {
        cell.classList.add(className('code--absent'));
    }
    return cell;
}

/**
 * A line-number cell, and the place a comment is started from.
 *
 * The button lives here rather than in a column of its own so that it appears beside *the version
 * being pointed at*. With one shared column at the left of the row, hovering the right-hand version
 * of a side-by-side diff put the button next to the left-hand one -- which is not merely misplaced,
 * it names the wrong side for the comment that follows.
 */
function gutterCell(
    lineNumber: number | undefined,
    side: AnchorSide | undefined): HTMLTableCellElement {
    const cell = element('td', className('gutter'), lineNumber === undefined ? '' : String(lineNumber));
    if (lineNumber !== undefined && side !== undefined) {
        cell.dataset.gutterSide = side;
        cell.dataset.gutterLine = String(lineNumber);
    }
    return cell;
}

/**
 * The `+` or `-` beside a line.
 *
 * Carries the same change class as the code it belongs to, because the tint covers the marker and the
 * code but not the line numbers -- which is how the built-in shelveset view draws it, and it keeps
 * the numbers legible against a coloured row.
 */
function markerCell(line: DiffLine | undefined): HTMLTableCellElement {
    const cell = element(
        'td',
        className('marker'),
        line === undefined || line.kind === 'context'
            ? ''
            : line.kind === 'added' ? '+' : '-');

    if (line !== undefined && line.kind !== 'context') {
        cell.classList.add(className(`marker--${line.kind}`));
    }
    return cell;
}
function renderRow(row: DiffRow, mode: DiffViewMode, rowIndex: number): HTMLTableRowElement {
    const tableRow = element('tr', className('row'));
    tableRow.dataset.rowIndex = String(rowIndex);

    if (isSingleSided(mode)) {
        const line = mode === 'base' ? row.base : row.reviewed;
        if (line !== undefined) {
            tableRow.classList.add(className(`row--${line.kind}`));
        }
        tableRow.appendChild(gutterCell(
            mode === 'base' ? row.base?.baseLine : row.reviewed?.reviewedLine, mode));
        tableRow.appendChild(markerCell(line));
        tableRow.appendChild(codeCell(line, mode));
        return tableRow;
    }

    if (mode === 'inline') {
        const line = row.reviewed ?? row.base;
        if (line !== undefined) {
            tableRow.classList.add(className(`row--${line.kind}`));
        }
        // A comment belongs to the side the line is on, so only that gutter offers the button.
        const onReviewed = row.reviewed !== undefined;
        tableRow.appendChild(gutterCell(row.base?.baseLine, onReviewed ? undefined : 'base'));
        tableRow.appendChild(gutterCell(row.reviewed?.reviewedLine, onReviewed ? 'reviewed' : undefined));
        tableRow.appendChild(markerCell(line));
        tableRow.appendChild(codeCell(line, onReviewed ? 'reviewed' : 'base'));
        return tableRow;
    }

    tableRow.appendChild(gutterCell(row.base?.baseLine, 'base'));
    tableRow.appendChild(markerCell(row.base));
    const baseCell = codeCell(row.base, 'base');
    // Named so the splitter can find the boundary, and so each column can be scrolled alone.
    baseCell.classList.add(className('code-left'));
    tableRow.appendChild(baseCell);
    tableRow.appendChild(gutterCell(row.reviewed?.reviewedLine, 'reviewed'));
    tableRow.appendChild(markerCell(row.reviewed));
    const reviewedCell = codeCell(row.reviewed, 'reviewed');
    reviewedCell.classList.add(className('code-right'));
    tableRow.appendChild(reviewedCell);
    return tableRow;
}

function fullWidthRow(
    cssClass: string,
    mode: DiffViewMode): { row: HTMLTableRowElement; cell: HTMLTableCellElement } {
    const row = element('tr', cssClass);
    const cell = element('td');
    cell.colSpan = columnCount(mode);
    row.appendChild(cell);
    return { row, cell };
}

function renderThreadRow(
    entries: readonly AnchoredThread[],
    writer: ReviewWriter | undefined,
    mode: DiffViewMode): HTMLTableRowElement {
    const { row, cell } = fullWidthRow(className('thread-row'), mode);
    for (const entry of entries) {
        cell.appendChild(renderThread(entry.thread, anchorLabelFor(entry), writer));
    }
    return row;
}

/**
 * A row standing in for a run of unchanged rows, which reveals them when clicked.
 *
 * The hidden rows never carry a comment: every row a thread is anchored to is forced to stay
 * visible, so nothing a reader needs to see is ever behind one of these.
 */
function renderExpanderRow(
    hiddenRows: readonly DiffRow[],
    mode: DiffViewMode,
    firstRowIndex: number): HTMLTableRowElement {
    const { row, cell } = fullWidthRow(className('collapsed-row'), mode);

    const button = element(
        'button', className('expander'), `Show ${plural(hiddenRows.length, 'unchanged line')}`);
    button.type = 'button';
    button.addEventListener('click', () => {
        const parent = row.parentNode;
        if (parent === null) {
            return;
        }
        hiddenRows.forEach((hidden, offset) => {
            parent.insertBefore(renderRow(hidden, mode, firstRowIndex + offset), row);
        });
        parent.removeChild(row);
    });

    cell.appendChild(button);
    return row;
}

/** A line range the reader has selected in one file's diff. */
interface SelectedRange {
    readonly side: AnchorSide;
    readonly startLine: number;
    readonly endLine: number;
    /** Row the "comment here" button and the form attach to. */
    readonly rowIndex: number;
}

function closestLineCell(node: Node | null): HTMLElement | undefined {
    const start = node === null
        ? null
        : (node instanceof HTMLElement ? node : node.parentElement);
    const cell = start?.closest<HTMLElement>('[data-line]');
    return cell ?? undefined;
}

/**
 * Turns the current text selection into a line range.
 *
 * Click, drag, release is the interaction, so the source of truth is the browser's own selection
 * rather than any bookkeeping of our own. A plain click collapses the selection, which is read as
 * selecting that single line -- so commenting on one line needs no separate gesture.
 *
 * A selection spanning both sides of a side-by-side diff is narrowed to the side it started on: a
 * comment belongs to one buffer, and guessing which would be worse than being predictable.
 */
export function resolveSelectedRange(container: HTMLElement): SelectedRange | undefined {
    const selection = container.ownerDocument.defaultView?.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return undefined;
    }

    const startCell = closestLineCell(selection.anchorNode);
    if (startCell === undefined || !container.contains(startCell)) {
        return undefined;
    }

    const endCandidate = closestLineCell(selection.focusNode);
    const endCell = endCandidate !== undefined
        && container.contains(endCandidate)
        && endCandidate.dataset.side === startCell.dataset.side
        ? endCandidate
        : startCell;

    const side: AnchorSide = startCell.dataset.side === 'base' ? 'base' : 'reviewed';
    const startLine = Number(startCell.dataset.line);
    const endLine = Number(endCell.dataset.line);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
        return undefined;
    }

    const rowIndexes = [startCell, endCell]
        .map((cell) => Number(cell.closest('tr')?.dataset.rowIndex))
        .filter((value) => Number.isFinite(value));

    return {
        side,
        startLine: Math.min(startLine, endLine),
        endLine: Math.max(startLine, endLine),
        // The button sits with the last row of the selection, which is also where a thread on that
        // range renders, so the comment appears where the reader is already looking.
        rowIndex: rowIndexes.length > 0 ? Math.max(...rowIndexes) : 0,
    };
}

interface DiffRenderContext {
    readonly host: HTMLElement;
    readonly diff: FileDiffResult;
    readonly codeThreads: readonly ReviewThread[];
    readonly file: ReviewedFile | undefined;
    readonly mode: DiffViewMode;
    readonly wordWrap: boolean;
    readonly writer: ReviewWriter | undefined;
    readonly state: ViewState;
    readonly root: HTMLElement;
    /**
     * How this file's two versions divide the width.
     *
     * Per file, and deliberately not remembered between sessions: it is a momentary adjustment
     * for reading one particular diff, not a preference about the tab. Carrying it over would
     * mean opening an unrelated review to find its columns already lopsided for reasons no
     * longer visible.
     */
    readonly columnRatio: number;
    readonly onColumnRatioChanged: (ratio: number) => void;
}

/**
 * Sizes the table when lines are not wrapped.
 *
 * Each column is sized to its own longest line, and the table to the sum, so it overflows the pane
 * and the pane's horizontal scrollbar reaches every character on both sides. Nothing is clipped and
 * nothing overlaps.
 *
 * This is why the column splitter is not offered in this combination, and the reason is worth stating
 * because it is a genuine conflict rather than an omission. Unwrapped, a column has to be at least as
 * wide as its longest line or that line is unreachable -- a table cell has no scrollbar of its own.
 * A splitter, though, only means something when the two columns divide a *fixed* width between them.
 * You can have columns sized to their content and a scrollbar, or columns sized by a ratio and text
 * cut off at the divider, but not both. Reaching the text wins.
 *
 * With wrapping on there is no conflict: every line fits by definition, the columns share the pane's
 * width, and the splitter decides how.
 */
function applyUnwrappedLayout(
    table: HTMLElement,
    leftCodeColumn: HTMLElement | undefined,
    lines: readonly DiffLine[],
    mode: DiffViewMode): void {
    const base = longestLineLength(lines, 'base');
    const reviewed = longestLineLength(lines, 'reviewed');

    if (mode === 'sideBySide' && leftCodeColumn !== undefined) {
        // Left to the percentage the splitter sets, and the table left at the pane's width: each
        // column scrolls on its own, so neither has to be as wide as its longest line.
        table.style.width = '';
        return;
    }

    const characters = mode === 'base'
        ? base
        : mode === 'reviewed'
            ? reviewed
            : Math.max(base, reviewed);
    table.style.width = `max(100%, calc(${Math.ceil(characters) + 2}ch + 12em))`;
}
/**
 * Sizes an unwrapped side-by-side table, and gives each version its own horizontal scrollbar.
 *
 * A table cell cannot scroll, so the two versions cannot simply be put in two scroll boxes without
 * splitting the table in half -- and splitting it would break the rows that span both columns: the
 * comment threads and the "show unchanged lines" expanders. Instead the cells clip, the text inside
 * them is shifted by a CSS custom property, and two real scrollbars drive that property. One write
 * per scroll event moves a whole column, however many rows it has.
 *
 * This is also what lets the column splitter work with wrapping off. The columns can now be sized by
 * the ratio rather than by their content, because content past a column's edge is reachable by
 * scrolling that column instead of being lost.
 */
function renderSideBySideScrollbars(
    table: HTMLElement,
    lines: readonly DiffLine[]): { element: HTMLElement; setRatio: (ratio: number) => void } {
    const strip = element('div', className('scrollbars'));

    const build = (side: 'left' | 'right', characters: number): HTMLElement => {
        const bar = element('div', `${className('scrollbar')} ${className(`scrollbar--${side}`)}`);
        bar.setAttribute('aria-hidden', 'true');

        const content = element('div', className('scrollbar-content'));
        content.style.width = `${characters + 2}ch`;
        bar.appendChild(content);

        bar.addEventListener('scroll', () => {
            table.style.setProperty(`--tfvc-${side}-scroll`, `${-bar.scrollLeft}px`);
        });

        return bar;
    };

    // Spacers stand in for the line-number gutters and change markers, so each scrollbar lines up
    // under the column it drives. Their widths mirror the table's colgroup exactly.
    const left = build('left', longestLineLength(lines, 'base'));
    strip.appendChild(element('div', className('scrollbar-gutter')));
    strip.appendChild(left);
    strip.appendChild(element('div', className('scrollbar-gutter')));
    strip.appendChild(build('right', longestLineLength(lines, 'reviewed')));

    return {
        element: strip,
        // The left column is a share of the table, so its scrollbar has to be the same share of the
        // strip -- and has to follow the splitter when that share changes.
        setRatio: (ratio) => { left.style.flexBasis = `${ratio * 100}%`; },
    };
}
function renderDiff(context: DiffRenderContext): void {
    const { host, diff, codeThreads, mode, writer } = context;

    if (diff.note) {
        host.appendChild(element('p', className('note'), diff.note));
    }

    const lines = diff.lines;
    if (lines === undefined) {
        // No diff to anchor against, so every thread is shown on its own with its line range named.
        for (const thread of codeThreads) {
            host.appendChild(renderThread(thread, detachedAnchorLabelFor(thread), writer));
        }
        return;
    }

    const rows = toRows(lines, mode);
    const anchored = anchorThreads(codeThreads, rows);

    const detached = anchored.filter((entry) => entry.rowIndex === undefined);
    if (detached.length > 0) {
        host.appendChild(element(
            'p',
            className('note'),
            'These comments point at lines that are in neither version of the file as it stands, so '
            + 'they are shown here rather than beside the code.'));
        for (const entry of detached) {
            host.appendChild(renderThread(entry.thread, anchorLabelFor(entry), writer));
        }
    }

    host.classList.toggle(className('diff-host--nowrap'), !context.wordWrap);
    // Side by side scrolls each version separately, through the strips below, so the box
    // itself must not scroll. Every other layout has a single code column and scrolls as one.
    // Decided here rather than with a :has() rule, which not every supported browser has.
    host.classList.toggle(
        className('diff-host--scrollx'), !context.wordWrap && mode !== 'sideBySide');

    const threadsByRow = groupByRow(anchored);
    const table = element('table', `${className('diff')} ${className(`diff--${mode}`)}`);
    const columns = renderDiffColumns(mode, context.columnRatio);
    table.appendChild(columns.group);
    const body = element('tbody');
    table.appendChild(body);

    let index = 0;
    for (const hunk of collapseUnchangedRows(rows, CONTEXT_ROW_COUNT, new Set(threadsByRow.keys()))) {
        if (hunk.collapsed) {
            body.appendChild(renderExpanderRow(hunk.rows, mode, index));
            index += hunk.rows.length;
            continue;
        }

        for (const row of hunk.rows) {
            body.appendChild(renderRow(row, mode, index));
            const threads = threadsByRow.get(index);
            if (threads !== undefined) {
                body.appendChild(renderThreadRow(threads, writer, mode));
            }
            index++;
        }
    }

    host.appendChild(table);

    const scrollbars = !context.wordWrap && mode === 'sideBySide'
        ? renderSideBySideScrollbars(table, lines)
        : undefined;
    if (scrollbars !== undefined) {
        host.appendChild(scrollbars.element);
    }

    let currentRatio = context.columnRatio;

    const applyLayout = (nextRatio: number): void => {
        scrollbars?.setRatio(nextRatio);
        currentRatio = nextRatio;
        if (context.wordWrap) {
            // Wrapped, the table fits the pane and the columns divide it by percentage.
            table.style.width = '';
            if (columns.leftCodeColumn !== undefined) {
                columns.leftCodeColumn.style.width = `${nextRatio * 100}%`;
            }
            return;
        }
        applyUnwrappedLayout(table, columns.leftCodeColumn, lines, mode);
        if (columns.leftCodeColumn !== undefined) {
            columns.leftCodeColumn.style.width = `%`;
        }
    };

    applyLayout(currentRatio);

    // The left column is a share of the pane, so a narrower pane means a narrower column.
    window.addEventListener('resize', () => {
        // Redrawing replaces the table; the listener outlives it and must not size a corpse.
        if (table.isConnected) {
            applyLayout(currentRatio);
        }
    });



    const leftCodeColumn = columns.leftCodeColumn;
    if (leftCodeColumn !== undefined) {
        host.appendChild(createColumnSplitter({
            host,
            root: context.root,
            initialRatio: context.columnRatio,
            measureFrom: () => table.querySelector<HTMLElement>(`.${className('code-left')}`)
                ?? undefined,
            applyRatio: applyLayout,
            // Kept so the adjustment survives a redraw of this file -- switching layout or
            // toggling whitespace rebuilds the table, and losing the divider each time would
            // make it feel broken.
            onRatioChanged: context.onColumnRatioChanged,
        }));
    }

    const file = context.file;
    if (writer !== undefined && file !== undefined) {
        attachRangeCommenting(table, body, lines, file, writer, mode);
    }
}

/**
 * Puts a comment button in the gutter of whichever line is under the pointer.
 *
 * Hovering, not selecting. A single click on the button comments on that one line, which is the
 * common case and previously took a deliberate text selection first. Dragging across several lines
 * still works: the selection wins when there is one, and the button then covers the whole range.
 *
 * The button is placed in the gutter of the side being pointed at. It used to live in a single column
 * at the left of the row, which meant hovering the right-hand version of a side-by-side diff offered
 * a button beside the left-hand one -- misleading about which version the comment would land on.
 */
function attachRangeCommenting(
    table: HTMLElement,
    body: HTMLElement,
    lines: readonly DiffLine[],
    file: ReviewedFile,
    writer: ReviewWriter,
    mode: DiffViewMode): void {
    let openButton: HTMLElement | undefined;

    const clearButton = (): void => {
        if (openButton !== undefined) {
            openButton.remove();
            openButton = undefined;
        }
    };

    /** Places the button in the gutter cell for `side` on the row at `rowIndex`. */
    const showButton = (
        rowIndex: number,
        side: AnchorSide,
        startLine: number,
        endLine: number): void => {
        clearButton();

        const row = body.querySelector<HTMLElement>(`tr[data-row-index="${rowIndex}"]`);
        const gutter = row?.querySelector<HTMLElement>(`td[data-gutter-side="${side}"]`);
        if (!row || !gutter) {
            return;
        }

        const label = startLine === endLine
            ? `Comment on line ${startLine}`
            : `Comment on lines ${startLine} to ${endLine}`;

        const button = iconButton(label);
        button.addEventListener('click', () => {
            clearButton();
            openRangeForm(row, { side, startLine, endLine, rowIndex }, lines, file, writer, mode);
        });

        gutter.appendChild(button);
        openButton = button;
    };

    body.addEventListener('mouseover', (event) => {
        // A selection is a deliberate statement about which lines are meant; a hover is not, so it
        // must not move a button the reader is on their way to click.
        if (resolveSelectedRange(table) !== undefined) {
            return;
        }

        const target = event.target;
        const cell = target instanceof Element
            ? target.closest<HTMLElement>('td[data-gutter-side], td[data-line]')
            : null;
        if (cell === null) {
            clearButton();
            return;
        }

        const side = cell.dataset.gutterSide ?? cell.dataset.side;
        const line = Number(cell.dataset.gutterLine ?? cell.dataset.line);
        const rowIndex = Number(cell.closest('tr')?.dataset.rowIndex);
        if ((side !== 'base' && side !== 'reviewed')
            || !Number.isFinite(line)
            || !Number.isFinite(rowIndex)) {
            return;
        }

        if (openButton?.parentElement?.dataset.gutterLine === String(line)
            && openButton.parentElement.dataset.gutterSide === side) {
            // Already showing for this line; moving it would make it flicker under the pointer.
            return;
        }

        showButton(rowIndex, side, line, line);
    });

    table.addEventListener('mouseleave', () => {
        if (resolveSelectedRange(table) === undefined) {
            clearButton();
        }
    });

    table.addEventListener('mouseup', () => {
        // Deferred a tick: on mouseup the selection is not always settled yet.
        window.setTimeout(() => {
            const range = resolveSelectedRange(table);
            if (range === undefined) {
                return;
            }
            showButton(range.rowIndex, range.side, range.startLine, range.endLine);
        }, 0);
    });
}

function openRangeForm(
    anchorRow: HTMLElement,
    range: SelectedRange,
    lines: readonly DiffLine[],
    file: ReviewedFile,
    writer: ReviewWriter,
    mode: DiffViewMode): void {
    const { row, cell } = fullWidthRow(className('thread-row'), mode);

    const remove = (): void => { row.remove(); };

    const text = sideLines(lines, range.side);
    const anchor: NewThreadAnchor = {
        itemPath: range.side === 'base' ? file.basePath : file.path,
        position: {
            startLine: range.startLine,
            endLine: range.endLine,
            side: range.side,
            startCharPosition: offsetOfLineStart(text, range.startLine),
            // The end of the selection is the start of the line after the last one it covers, which
            // is the same exclusive convention the line numbers use.
            endCharPosition: offsetOfLineStart(text, range.endLine + 1),
        },
    };

    cell.appendChild(renderCommentForm({
        placeholder: range.startLine === range.endLine
            ? `Comment on line ${range.startLine}`
            : `Comment on lines ${range.startLine} to ${range.endLine}`,
        submitLabel: 'Comment',
        onCancel: remove,
        onSubmit: async (content) => {
            const created = await writer.createThread(anchor, content);
            cell.textContent = '';
            cell.appendChild(renderThread(
                created,
                describeThreadAnchor(range.startLine, range.endLine)
                + (range.side === 'base' ? ' (base version)' : ''),
                writer));
        },
    }));

    anchorRow.parentNode?.insertBefore(row, anchorRow.nextSibling);
}

/**
 * Display settings one file has been given of its own.
 *
 * An absent value means "whatever the tab is set to", so changing the tab-wide control still moves
 * every file that has not been given an opinion. Deliberately not remembered between sessions: these
 * are adjustments made while reading one diff, and carrying them into a later review would mean
 * finding files laid out oddly for reasons no longer on screen.
 */
interface FileDisplayOverrides {
    mode?: DiffViewMode;
    wordWrap?: boolean;
    ignoreWhitespace?: boolean;
}

interface EffectiveDisplay {
    readonly mode: DiffViewMode;
    readonly wordWrap: boolean;
    readonly ignoreWhitespace: boolean;
}

function effectiveDisplay(state: ViewState, overrides: FileDisplayOverrides): EffectiveDisplay {
    return {
        mode: overrides.mode ?? state.mode,
        wordWrap: overrides.wordWrap ?? state.wordWrap,
        ignoreWhitespace: overrides.ignoreWhitespace ?? state.ignoreWhitespace,
    };
}

/** What choosing a display item does, which is all that differs between the two menus. */
interface DisplayActions {
    readonly setMode: (mode: DiffViewMode) => void;
    readonly setWordWrap: (wrap: boolean) => void;
    readonly setIgnoreWhitespace: (ignore: boolean) => void;
}

/**
 * The display settings, as menu items.
 *
 * One builder for both menus -- the tab-wide one and each file's own -- because they offer the same
 * choices and differ only in what a choice applies to. Two lists would drift, and a file whose menu
 * said something different from the tab's would be the least explicable kind of bug.
 *
 * Grouped and worded after the equivalent menu in Visual Studio's diff window, so the wording is
 * already familiar to anyone who reviews code there.
 */
function displayMenuGroups(current: EffectiveDisplay, actions: DisplayActions): MenuGroup[] {
    const layout = (mode: DiffViewMode, label: string): MenuItem => ({
        label,
        checked: current.mode === mode,
        onChoose: () => { actions.setMode(mode); },
    });

    return [
        {
            items: [
                layout('inline', 'Inline mode'),
                layout('sideBySide', 'Side-by-side mode'),
                layout('base', 'Left file only'),
                layout('reviewed', 'Right file only'),
            ],
        },
        {
            items: [
                {
                    label: 'Wrap long lines',
                    checked: current.wordWrap,
                    onChoose: () => { actions.setWordWrap(!current.wordWrap); },
                },
                {
                    label: 'Ignore trim whitespace',
                    checked: current.ignoreWhitespace,
                    onChoose: () => { actions.setIgnoreWhitespace(!current.ignoreWhitespace); },
                },
            ],
        },
    ];
}

/**
 * The display options for one file.
 *
 * A menu rather than a strip of buttons under the header: these are occasional adjustments, and a row
 * of six controls above every file in a review of ninety would be a permanent band of chrome paid for
 * by the few files anyone changes the view on.
 */
function openFileDisplayMenu(
    anchor: HTMLElement,
    state: ViewState,
    overrides: FileDisplayOverrides,
    path: string,
    redraw: () => void): void {
    const groups = displayMenuGroups(effectiveDisplay(state, overrides), {
        setMode: (mode) => { overrides.mode = mode; redraw(); },
        setWordWrap: (wrap) => { overrides.wordWrap = wrap; redraw(); },
        setIgnoreWhitespace: (ignore) => { overrides.ignoreWhitespace = ignore; redraw(); },
    });

    const overridden = overrides.mode !== undefined
        || overrides.wordWrap !== undefined
        || overrides.ignoreWhitespace !== undefined;

    if (overridden) {
        groups.push({
            items: [{
                label: 'Use the settings above',
                onChoose: () => {
                    delete overrides.mode;
                    delete overrides.wordWrap;
                    delete overrides.ignoreWhitespace;
                    redraw();
                },
            }],
        });
    }

    // The header shows the file name; this is where the rest of it can be had.
    groups.push({ items: [{ label: 'Copy full path', onChoose: () => { copyText(path); } }] });

    openMenu(anchor, groups);
}

/**
 * The display options for the whole tab.
 *
 * Behind a gear for the same reason the per-file settings are: these are set once and then left, and
 * six buttons across the top were spending a band of a short frame on controls nobody was using.
 * Every file that has not been given an opinion of its own follows what is chosen here.
 */
function openViewDisplayMenu(anchor: HTMLElement, state: ViewState, model: ReviewViewModel): void {
    const redrawAll = (): void => {
        // Only files already loaded are redrawn; the rest pick the setting up when they load.
        for (const redraw of state.redraw) {
            redraw();
        }
    };

    openMenu(anchor, displayMenuGroups(state, {
        setMode: (mode) => {
            state.mode = mode;
            redrawAll();
            model.onViewModeChanged?.(mode);
        },
        setWordWrap: (wrap) => {
            state.wordWrap = wrap;
            redrawAll();
            model.onWordWrapChanged?.(wrap);
        },
        setIgnoreWhitespace: (ignore) => {
            state.ignoreWhitespace = ignore;
            // Every open file is diffed again from content already fetched, so this costs no
            // requests.
            redrawAll();
            model.onIgnoreWhitespaceChanged?.(ignore);
        },
    }));
}

/** The gear that opens a display menu, and the toggling its button needs. */
function renderDisplayMenuButton(label: string, open: (anchor: HTMLElement) => void): HTMLButtonElement {
    const button = element('button', className('icon-button'));
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.appendChild(gearIcon());

    button.addEventListener('click', () => {
        // Toggling: a second click on the gear should put the menu away, not reopen it.
        if (button.getAttribute('aria-expanded') === 'true') {
            closeMenu();
            return;
        }
        open(button);
    });

    return button;
}
interface FileBlockOptions {
    /** Absent when threads name a path that is not among the review's changes. */
    readonly file: ReviewedFile | undefined;
    readonly root: HTMLElement;
    readonly path: string;
    readonly threads: FileThreadGroup | undefined;
    readonly expanded: boolean;
    readonly model: ReviewViewModel;
    readonly state: ViewState;
}

interface ViewState {
    mode: DiffViewMode;
    /** Whether whitespace-only differences count as changes. */
    ignoreWhitespace: boolean;
    /** Whether long lines wrap, which decides whether a column splitter can be aligned. */
    wordWrap: boolean;
    /** Re-renders every diff that has already been loaded, after a view mode change. */
    readonly redraw: (() => void)[];
    /** The element that scrolls, which is what "in view" is measured against. */
    readonly scrollRoot: HTMLElement;
}

/**
 * Fetches a file's content once it is close to being looked at.
 *
 * Every file is open from the start, so that the review reads as one scrollable document. Fetching
 * all of them up front would mean two requests per file -- closer to two hundred on a review of this
 * size -- before the reader has looked at anything. Waiting until each is near the viewport keeps
 * both properties: the whole review is there to scroll through, and the requests follow the reader.
 *
 * Where `IntersectionObserver` is missing the content is fetched immediately. That is the honest
 * fallback: a slow load is recoverable, a file that never loads is not.
 */
function loadWhenNearViewport(
    target: HTMLElement,
    scrollRoot: HTMLElement,
    load: () => void): void {
    if (typeof IntersectionObserver !== 'function') {
        load();
        return;
    }

    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                observer.disconnect();
                load();
                return;
            }
        }
    }, { root: scrollRoot, rootMargin: PRELOAD_MARGIN });

    observer.observe(target);
}

/** Trailing segment of a server path, which is what identifies a file at a glance. */
export function fileNameOf(path: string): string {
    const segments = path.split('/').filter((segment) => segment.length > 0);
    return segments.length > 0 ? segments[segments.length - 1] : path;
}

/**
 * The `+2 -2` counts beside a file name.
 *
 * Filled in once the diff has been built rather than rendered with the header: the counts come from
 * the diff, and the diff is fetched only when the file nears the viewport. They stay empty until
 * then, which is also what the built-in view does while a file is still loading.
 */
function renderChangeCounts(): {
    element: HTMLElement;
    update: (added: number, removed: number) => void;
} {
    const host = element('span', className('file-counts'));

    return {
        element: host,
        update: (added, removed) => {
            host.textContent = '';
            if (added > 0) {
                host.appendChild(element('span', className('file-count-added'), `+${added}`));
            }
            if (removed > 0) {
                host.appendChild(element('span', className('file-count-removed'), `-${removed}`));
            }
        },
    };
}
function renderBadge(threads: FileThreadGroup): HTMLElement {
    const badge = element(
        'span', className('file-badge'), describeThreadCount(threads.total, threads.unresolved));

    // Highlighted only when the count is actually shown. Where every thread is unresolved, every
    // badge would be highlighted, which draws the eye to nothing in particular.
    if (threads.unresolved > 0 && threads.unresolved < threads.total) {
        badge.classList.add(className('file-badge--unresolved'));
    }
    return badge;
}

function renderFileBlock(options: FileBlockOptions): HTMLElement {
    const writer = options.model.writer;
    const container = element('div', className('file'));

    const header = element('div', className('file-header'));

    const toggle = element('button', className('file-toggle'));
    toggle.type = 'button';
    const glyph = element(
        'span', className('file-glyph'), options.expanded ? EXPANDED_GLYPH : COLLAPSED_GLYPH);
    toggle.appendChild(glyph);

    // The name and its counts. The full path is the header's tooltip rather than a second line:
    // it is what tells two files of the same name apart, but it is wanted once in a while, and a
    // line of it above every file was a band of small grey text down the whole review. The menu
    // beside the header can put it on the clipboard.
    toggle.title = options.path;
    const labels = element('span', className('file-labels'));
    const nameRow = element('span', className('file-name-row'));
    nameRow.appendChild(element('span', className('file-name'), fileNameOf(options.path)));

    const counts = renderChangeCounts();
    nameRow.appendChild(counts.element);

    // Only where it says something the counts do not: an edit is the ordinary case and needs no word.
    const changeType = options.file?.changeType ?? '';
    if (changeType && !/^edit$/i.test(changeType)) {
        nameRow.appendChild(element('span', className('file-change'), changeType));
    }

    if (options.threads !== undefined && options.threads.total > 0) {
        nameRow.appendChild(renderBadge(options.threads));
    }

    labels.appendChild(nameRow);
    toggle.appendChild(labels);
    toggle.setAttribute('aria-expanded', String(options.expanded));

    // The file-level comment button sits outside the toggle, at the leading edge: a button cannot be
    // nested inside another button, and this way clicking it never also collapses the file.
    if (writer !== undefined) {
        header.appendChild(renderFileCommentButton(container, options.path, writer));
    }
    header.appendChild(toggle);

    const optionsButton = renderDisplayMenuButton('Display settings for this file', (anchor) => {
        // Choosing a layout for a file nobody can see would look like nothing had happened.
        if (body.hidden) {
            body.hidden = false;
            toggle.setAttribute('aria-expanded', 'true');
            glyph.textContent = EXPANDED_GLYPH;
            ensureLoaded();
        }

        openFileDisplayMenu(anchor, options.state, overrides, options.path, draw);
    });
    header.appendChild(optionsButton);

    container.appendChild(header);

    const body = element('div', className('file-body'));
    body.hidden = !options.expanded;
    container.appendChild(body);

    const overrides: FileDisplayOverrides = {};

    // File-level threads are about the file as a whole, so they sit above the diff and are rendered
    // immediately rather than waiting on content that has nothing to do with them.
    const fileThreadHost = element('div', className('file-threads'));
    for (const thread of options.threads?.fileThreads ?? []) {
        fileThreadHost.appendChild(renderThread(thread, '', writer));
    }
    body.appendChild(fileThreadHost);
    container.dataset.fileThreadHost = 'true';

    const changeNote = options.file === undefined ? '' : describeFileChange(options.file);
    if (changeNote) {
        body.appendChild(element('p', className('note'), changeNote));
    }

    const diffHost = element('div', className('diff-host'));
    body.appendChild(diffHost);

    const codeThreads = options.threads?.codeThreads ?? [];
    let loadStarted = false;
    let content: ReviewedFileContent | undefined;
    let columnRatio = DEFAULT_COLUMN_RATIO;


    const draw = (): void => {
        if (content === undefined) {
            return;
        }
        const display = effectiveDisplay(options.state, overrides);

        const built = buildFileDiff(content, { ignoreWhitespace: display.ignoreWhitespace });
        counts.update(
            (built.lines ?? []).filter((line) => line.kind === 'added').length,
            (built.lines ?? []).filter((line) => line.kind === 'removed').length);

        diffHost.textContent = '';
        renderDiff({
            host: diffHost,
            diff: built,
            codeThreads,
            file: options.file,
            mode: display.mode,
            wordWrap: display.wordWrap,
            writer,
            state: options.state,
            root: options.root,
            columnRatio,
            onColumnRatioChanged: (next) => { columnRatio = next; },
        });
    };
    options.state.redraw.push(draw);

    const ensureLoaded = (): void => {
        if (loadStarted) {
            return;
        }
        loadStarted = true;

        const file = options.file;
        if (file === undefined) {
            diffHost.appendChild(element(
                'p',
                className('note'),
                'This path is not among the changes in this review, so there is no diff to show. '
                + 'The comments on it are below.'));
            for (const thread of codeThreads) {
                diffHost.appendChild(renderThread(thread, detachedAnchorLabelFor(thread), writer));
            }
            return;
        }

        diffHost.appendChild(element('p', className('empty'), 'Loading the diff\u2026'));

        options.model.loadFileContent(file)
            .then((loaded) => {
                content = loaded;
                draw();
            })
            .catch((error: unknown) => {
                // The comments are the point of this tab, so a failure here costs the diff and
                // nothing else.
                diffHost.textContent = '';
                diffHost.appendChild(element(
                    'p',
                    className('warning'),
                    `The diff could not be loaded: ${describeError(error)}`));
                for (const thread of codeThreads) {
                    diffHost.appendChild(renderThread(thread, detachedAnchorLabelFor(thread), writer));
                }
            });
    };

    toggle.addEventListener('click', () => {
        const expanded = body.hidden;
        body.hidden = !expanded;
        toggle.setAttribute('aria-expanded', String(expanded));
        glyph.textContent = expanded ? EXPANDED_GLYPH : COLLAPSED_GLYPH;
        if (expanded) {
            ensureLoaded();
        }
    });

    if (options.expanded) {
        loadWhenNearViewport(diffHost, options.state.scrollRoot, ensureLoaded);
    }

    return container;
}

/** The chat-bubble-with-a-plus button that starts a comment about a whole file. */
function renderFileCommentButton(
    container: HTMLElement,
    path: string,
    writer: ReviewWriter): HTMLElement {
    const button = iconButton('Comment on this file');

    button.addEventListener('click', () => {
        const body = container.querySelector<HTMLElement>(`.${className('file-body')}`);
        const host = container.querySelector<HTMLElement>(`.${className('file-threads')}`);
        if (!body || !host) {
            return;
        }
        // Opening the form on a collapsed file would put it out of sight.
        body.hidden = false;

        const formHost = element('div');
        const remove = (): void => { formHost.remove(); };
        formHost.appendChild(renderCommentForm({
            placeholder: 'Comment on this file',
            submitLabel: 'Comment',
            onCancel: remove,
            onSubmit: async (content) => {
                const created = await writer.createThread({ itemPath: path }, content);
                formHost.remove();
                host.appendChild(renderThread(created, '', writer));
            },
        }));
        host.appendChild(formHost);
    });

    return button;
}

/** How close to a difference already counts as being on it rather than before or after it. */
const DIFFERENCE_TOLERANCE_PIXELS = 4;

/** Space left above a difference the navigation moves to, so it does not sit against the top edge. */
const DIFFERENCE_MARGIN_PIXELS = 12;

/**
 * The first row of each run of changed lines, in the order they appear.
 *
 * A run counts as one difference. Stepping through a rewritten block of twenty lines one line at a
 * time would make the buttons useless on exactly the changes worth reading, which is what Visual
 * Studio's own next-difference does and why it is worth matching.
 *
 * Found from the changed *cells* rather than the rows, because only some layouts mark the row: side
 * by side puts a removed line and an added one in the same row, so the row itself is neither.
 */
export function findDifferenceRows(content: HTMLElement): readonly HTMLElement[] {
    const starts: HTMLElement[] = [];
    let previous: HTMLElement | undefined;

    for (const cell of Array.from(content.querySelectorAll<HTMLElement>(
        `.${className('code--added')}, .${className('code--removed')}`))) {
        const row = cell.closest('tr');
        // The second changed cell of a side-by-side row names a row already accounted for.
        if (row === null || row === previous) {
            continue;
        }
        if (previous === undefined || row.previousElementSibling !== previous) {
            starts.push(row);
        }
        previous = row;
    }

    return starts;
}

/**
 * Which difference to move to, as an index into offsets taken in document order.
 *
 * Separated from the DOM because the arithmetic is the part worth testing and geometry is the part
 * jsdom does not have: every element it renders reports a height of zero.
 */
export function findAdjacentDifference(
    offsets: readonly number[],
    currentTop: number,
    direction: 'previous' | 'next'): number | undefined {
    if (direction === 'next') {
        for (let index = 0; index < offsets.length; index++) {
            if (offsets[index] > currentTop + DIFFERENCE_TOLERANCE_PIXELS) {
                return index;
            }
        }
        return undefined;
    }

    for (let index = offsets.length - 1; index >= 0; index--) {
        if (offsets[index] < currentTop - DIFFERENCE_TOLERANCE_PIXELS) {
            return index;
        }
    }
    return undefined;
}

/**
 * The previous/next difference buttons.
 *
 * They move through the differences that are on the page. A review's files load as they near the
 * viewport, so the last difference in the loaded part is where "next" stops -- pressing it again once
 * the following file has arrived carries on. The alternative, loading the whole review to make the
 * button complete, is the request storm the lazy loading exists to avoid.
 */
function renderDifferenceNavigation(content: HTMLElement): HTMLElement {
    const group = element('div', className('button-group'));
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Move between differences');

    const move = (direction: 'previous' | 'next'): void => {
        const rows = findDifferenceRows(content);
        if (rows.length === 0) {
            return;
        }

        // Measured against the pane's own scrolled content, which is what `scrollTop` addresses.
        const origin = content.getBoundingClientRect().top - content.scrollTop;
        const offsets = rows.map((row) => row.getBoundingClientRect().top - origin);

        // Reading and writing the position through the same allowance is what makes two presses move
        // two differences rather than the second finding itself already there.
        const allowance = DIFFERENCE_MARGIN_PIXELS;
        const index = findAdjacentDifference(offsets, content.scrollTop + allowance, direction);
        if (index === undefined) {
            return;
        }

        content.scrollTop = Math.max(0, offsets[index] - allowance);

        const row = rows[index];
        row.classList.add(className('row--targeted'));
        window.setTimeout(() => { row.classList.remove(className('row--targeted')); }, 1200);
    };

    for (const entry of [
        { direction: 'previous' as const, arrow: 'up' as const, label: 'Previous difference' },
        { direction: 'next' as const, arrow: 'down' as const, label: 'Next difference' },
    ]) {
        const button = element('button', className('icon-button'));
        button.type = 'button';
        button.title = entry.label;
        button.setAttribute('aria-label', entry.label);
        button.appendChild(arrowIcon(entry.arrow));
        button.addEventListener('click', () => { move(entry.direction); });
        group.appendChild(button);
    }

    return group;
}

/**
 * Where the reviewed shelveset or changeset can be opened in the web UI.
 *
 * The shelveset route wants `name;owner`, and it accepts the owner as an identity GUID -- which is
 * the form the work item stores, so nothing has to be resolved first. Verified against a live
 * collection; the `name;DOMAIN\user` form that the web UI itself produces works too, but building
 * that would mean turning a GUID back into an account name for no gain.
 */
export function resolveTargetUrl(
    collectionUri: string,
    projectName: string,
    target: ReviewTarget): string | undefined {
    if (!collectionUri || !projectName || target.kind === 'unknown') {
        return undefined;
    }

    const base = `${collectionUri.replace(/\/+$/, '')}/${encodeURIComponent(projectName)}`;
    return target.kind === 'shelveset'
        ? `${base}/_versionControl/shelveset?ss=${encodeURIComponent(target.shelvesetId)}`
        : `${base}/_versionControl/changeset/${encodeURIComponent(String(target.changesetId))}`;
}

/**
 * The review's heading: the shelveset or changeset, with only its name as a link.
 *
 * The word in front of the name is a label, and underlining it would say the word itself leads
 * somewhere.
 */
function renderReviewHeading(model: ReviewViewModel): HTMLElement {
    const heading = element('h2', className('review-heading'));
    const target = model.reviewContext.target;

    const kind = target.kind === 'shelveset' ? 'Shelveset'
        : target.kind === 'changeset' ? 'Changeset'
            : '';
    const name = target.kind === 'shelveset' ? target.shelvesetName
        : target.kind === 'changeset' ? String(target.changesetId)
            : target.reason;

    if (kind) {
        heading.appendChild(element('span', className('review-heading-kind'), `${kind} `));
    }

    const url = resolveTargetUrl(model.collectionUri ?? '', model.projectName ?? '', target);
    if (url === undefined) {
        heading.appendChild(element('span', className('review-heading-name'), name));
        return heading;
    }

    const link = element('a', className('review-heading-name'), name);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'Open in version control (new tab)';
    // The link leaves the page, and saying so before the click is the point of the icon.
    link.appendChild(externalLinkIcon(className('external-icon')));
    heading.appendChild(link);

    return heading;
}

/**
 * What the review contains, and the control that asks for it.
 *
 * Folded away by default. It is worth having -- it says whether the file list is complete and how
 * much discussion there is -- but it is read once, and it was spending a permanent line of a frame
 * that is only a few hundred pixels tall on a sentence nobody rereads. The built-in shelveset view
 * treats its own details the same way.
 *
 * The chevron is a control of its own rather than something the heading does, because the heading is
 * a link: one gesture cannot both open version control and expand a panel.
 */
function renderReviewDetails(
    model: ReviewViewModel,
    grouped: ReturnType<typeof groupThreads>): { toggle: HTMLButtonElement; panel: HTMLElement } {
    const panel = element('div', className('review-details'));
    panel.hidden = true;
    panel.appendChild(element(
        'span', className('review-summary'), describeContents(model, grouped)));

    const toggle = element('button', className('details-toggle'));
    toggle.type = 'button';
    toggle.title = 'Show what this review contains';
    toggle.setAttribute('aria-label', 'Show what this review contains');
    toggle.setAttribute('aria-expanded', 'false');

    const glyph = element('span', className('file-glyph'), COLLAPSED_GLYPH);
    toggle.appendChild(glyph);

    toggle.addEventListener('click', () => {
        const expanded = panel.hidden;
        panel.hidden = !expanded;
        toggle.setAttribute('aria-expanded', String(expanded));
        glyph.textContent = expanded ? EXPANDED_GLYPH : COLLAPSED_GLYPH;
    });

    return { toggle, panel };
}

/** How a closure reads once it is stored on the work item. */
function describeClosure(closure: ReviewClosure): string {
    return CLOSED_STATUS_VALUES[closure];
}

/** The badge on a closed review, naming how it ended where the work item recorded it. */
export function describeClosedState(closedStatus: string | undefined): string {
    return closedStatus ? `Closed (${closedStatus})` : 'Closed';
}

/**
 * Closing the review: the menu, and the step that stands between the menu and the deed.
 *
 * The two choices are Visual Studio's, and they are the two actions the work item type names on the
 * transition it offers -- Complete writes `Checked-in`, Abandon writes `Abandoned`.
 *
 * Choosing one opens a confirmation rather than closing the review there and then. **A closed review
 * cannot be reopened**: the work item type defines no transition out of `Closed`, so this is a
 * one-way action reachable in two clicks from a menu that also holds harmless things, and it is worth
 * a deliberate second step. The confirmation is also where a closing note goes, which is what Visual
 * Studio records on the review's history when someone explains an abandonment.
 */
function renderCloseReview(
    closer: ReviewCloser,
    onClosed: (closure: ReviewClosure) => void): { button: HTMLButtonElement; panel: HTMLElement } {
    const panel = element('div', className('close-panel'));
    panel.hidden = true;

    const button = element('button', className('text-button'), 'Close review');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.appendChild(element('span', className('text-button-caret'), MENU_CARET_GLYPH));

    const dismiss = (): void => {
        panel.hidden = true;
        panel.textContent = '';
    };

    const confirm = (closure: ReviewClosure): void => {
        panel.textContent = '';
        panel.hidden = false;

        const status = element('p', className('comment-form-error'));
        status.hidden = true;
        panel.appendChild(status);

        panel.appendChild(element(
            'p',
            className('close-question'),
            closure === 'abandoned'
                ? 'Abandon this review? It will be closed as abandoned, and a closed review cannot '
                    + 'be reopened.'
                : 'Complete this review? It will be closed as checked in, and a closed review cannot '
                    + 'be reopened.'));

        const note = element('textarea', className('comment-input'));
        note.rows = 2;
        note.placeholder = 'Add a note to the review history (optional)';
        note.setAttribute('aria-label', 'Add a note to the review history (optional)');
        panel.appendChild(note);

        const actions = element('div', className('comment-form-actions'));
        const submit = element(
            'button',
            className('button'),
            closure === 'abandoned' ? 'Abandon review' : 'Complete review');
        submit.type = 'button';
        const cancel = element('button', className('button'), 'Cancel');
        cancel.type = 'button';
        actions.appendChild(submit);
        actions.appendChild(cancel);
        panel.appendChild(actions);

        const setBusy = (busy: boolean): void => {
            submit.disabled = busy;
            cancel.disabled = busy;
            note.readOnly = busy;
        };

        submit.addEventListener('click', () => {
            status.hidden = true;
            setBusy(true);

            closer.close(closure, note.value)
                .then(() => {
                    dismiss();
                    // The work item is saved, and nothing here can reopen it, so the control that
                    // did it goes away rather than staying as an offer that would now fail.
                    button.remove();
                    onClosed(closure);
                })
                .catch((error: unknown) => {
                    // The note stays where it was typed: whatever refused the close, retyping it is
                    // not the fix.
                    setBusy(false);
                    status.hidden = false;
                    status.textContent = `The review was not closed: ${describeError(error)}`;
                });
        });

        cancel.addEventListener('click', dismiss);
        window.setTimeout(() => { note.focus(); }, 0);
    };

    button.addEventListener('click', () => {
        if (button.getAttribute('aria-expanded') === 'true') {
            closeMenu();
            return;
        }

        openMenu(button, [{
            items: [
                { label: 'Complete', onChoose: () => { confirm('checkedIn'); } },
                { label: 'Abandon', onChoose: () => { confirm('abandoned'); } },
            ],
        }]);
    });

    return { button, panel };
}

/** What the review contains, as one line. */
function describeContents(
    model: ReviewViewModel,
    grouped: ReturnType<typeof groupThreads>): string {
    const parts: string[] = [];
    if (model.filesError === undefined) {
        parts.push(`Showing ${plural(model.files.length, 'file change')}`);
    }
    parts.push(describeThreadCount(grouped.total, grouped.unresolved));
    return parts.join(' \u00b7 ');
}

/** Renders the whole tab for a code review request. */
export function renderReview(host: HTMLElement, model: ReviewViewModel): void {
    const grouped = groupThreads(model.threads);
    const root = resetRoot(host);
    const writer = model.writer;

    // Two panes below the header: the navigation tree, and the review itself. The review pane is
    // what scrolls, so it is also what "near the viewport" is measured against -- which is why it is
    // built before the state that refers to it.
    const treePane = element('nav', className('tree'));
    treePane.setAttribute('aria-label', 'Review navigation');
    const content = element('div', className('content'));

    const state: ViewState = {
        mode: model.initialViewMode ?? 'inline',
        ignoreWhitespace: model.initialIgnoreWhitespace ?? false,
        wordWrap: model.initialWordWrap ?? true,
        redraw: [],
        scrollRoot: content,
    };

    const layout = createPaneLayout({
        pane: treePane,
        root,
        initial: {
            width: model.treePane?.width ?? DEFAULT_TREE_WIDTH,
            collapsed: model.treePane?.collapsed ?? false,
        },
        onChanged: (next) => {
            if (model.onTreePaneChanged) {
                model.onTreePaneChanged(next);
            }
        },
    });

    // No title here: the work item form already shows it directly above the tab, and repeating
    // it spends a line of a short frame saying what the reader has just read.
    //
    // One row holds everything that is about the review as a whole: what is being reviewed, the
    // way through it, and how it is shown. It sits above both panes rather than inside the one that
    // scrolls, so it is simply always there -- no pinning, and nothing scrolling underneath it.
    const heading = element('div', className('heading-row'));
    const details = renderReviewDetails(model, grouped);
    heading.appendChild(details.toggle);
    heading.appendChild(renderReviewHeading(model));

    // Says why there is nothing to close, and what happened to a review that already is.
    const closedBadge = element('span', className('review-state'));
    closedBadge.hidden = !model.reviewContext.isClosed;
    closedBadge.textContent = describeClosedState(model.reviewContext.closedStatus);
    heading.appendChild(closedBadge);

    heading.appendChild(renderDifferenceNavigation(content));

    const actions = element('div', className('heading-actions'));
    const closer = model.closer;
    let closePanel: HTMLElement | undefined;

    if (closer !== undefined && !model.reviewContext.isClosed) {
        const close = renderCloseReview(closer, (closure) => {
            closedBadge.textContent = describeClosedState(describeClosure(closure));
            closedBadge.hidden = false;
        });
        actions.appendChild(close.button);
        closePanel = close.panel;
    }

    actions.appendChild(renderDisplayMenuButton(
        'Display settings', (anchor) => { openViewDisplayMenu(anchor, state, model); }));
    heading.appendChild(actions);

    root.appendChild(heading);
    if (closePanel !== undefined) {
        root.appendChild(closePanel);
    }
    root.appendChild(details.panel);

    const treeHeader = element('div', className('tree-header'));
    treeHeader.appendChild(element('span', className('tree-title'), 'Files'));
    treeHeader.appendChild(layout.collapseButton);
    treePane.appendChild(treeHeader);

    const body = element('div', className('body'));
    body.appendChild(layout.expandButton);
    body.appendChild(treePane);
    body.appendChild(layout.splitter);
    body.appendChild(content);
    root.appendChild(body);

    if (model.filesError !== undefined) {
        content.appendChild(element(
            'p',
            className('warning'),
            `The changed files could not be listed, so no diffs are available: ${model.filesError}`));
    }

    if (grouped.reviewThreads.length > 0) {
        const reviewSection = section('Review');
        for (const thread of grouped.reviewThreads) {
            reviewSection.appendChild(renderThread(thread, '', writer));
        }
        content.appendChild(reviewSection);
    }

    if (grouped.total === 0) {
        content.appendChild(element(
            'p',
            className('empty'),
            writer === undefined
                ? 'This review has no comments.'
                : 'This review has no comments yet. Use the comment button on a file, or select '
                    + 'lines in a diff, to add the first one.'));
    }

    // Paths that carry threads are matched against the review's changes, so a thread whose file was
    // removed from the shelveset after it was written is still accounted for below.
    const matchedPaths = new Set<string>();
    const blocksByPath = new Map<string, HTMLElement>();

    if (model.files.length > 0) {
        // One flat list in path order. The files are already sorted by path when they are listed.
        const filesSection = section(`Files (${model.files.length})`);
        for (const file of model.files) {
            const threads = findFileThreads(grouped, file.path);
            if (threads !== undefined) {
                matchedPaths.add(normalizeItemPath(threads.path));
            }
            const block = renderFileBlock({
                file,
                path: file.path,
                threads,
                // Every file starts open, so the review reads as one document to scroll through.
                // Its content is still fetched only as it nears the viewport.
                expanded: true,
                model,
                state,
                root,
            });
            blocksByPath.set(normalizeItemPath(file.path), block);
            filesSection.appendChild(block);
        }
        content.appendChild(filesSection);
    }

    const orphaned = grouped.files
        .filter((group) => !matchedPaths.has(normalizeItemPath(group.path)));

    if (orphaned.length > 0) {
        const orphanSection = section(`Comments on files outside this review (${orphaned.length})`);
        orphanSection.appendChild(element(
            'p',
            className('note'),
            'These files carry comments but are not among the changes this review covers. That '
            + 'happens when a file is removed from the shelveset after someone comments on it.'));
        for (const group of orphaned) {
            orphanSection.appendChild(renderFileBlock({
                file: undefined,
                path: group.path,
                threads: group,
                expanded: true,
                model,
                state,
                root,
            }));
        }
        content.appendChild(orphanSection);
    }

    renderNavigationTree(treePane, model, grouped, blocksByPath);
}

/**
 * Fills the navigation pane.
 *
 * The tree lists the review's own files only. A path that carries comments but is not among the
 * changes has its own section in the review pane, and putting it in a tree labelled "files in this
 * review" would say something untrue about it.
 */
function renderNavigationTree(
    treePane: HTMLElement,
    model: ReviewViewModel,
    grouped: ReturnType<typeof groupThreads>,
    blocksByPath: ReadonlyMap<string, HTMLElement>): void {
    if (model.files.length === 0) {
        treePane.appendChild(element('p', className('empty'), 'No files to show.'));
        return;
    }

    const nodes = buildFileTree(model.files.map((file) => ({
        path: file.path,
        threadCount: findFileThreads(grouped, file.path)?.total ?? 0,
        deleted: isDelete(file.changeType),
    })));

    treePane.appendChild(renderFileTree({
        nodes,
        onSelect: (path) => {
            const block = blocksByPath.get(normalizeItemPath(path));
            if (block === undefined) {
                return;
            }
            // Guarded because jsdom does not implement scrollIntoView, and navigation is not worth
            // throwing over.
            if (typeof block.scrollIntoView === 'function') {
                block.scrollIntoView({ block: 'start' });
            }
            block.classList.add(className('file--targeted'));
            window.setTimeout(() => {
                block.classList.remove(className('file--targeted'));
            }, 1200);
        },
    }));
}
