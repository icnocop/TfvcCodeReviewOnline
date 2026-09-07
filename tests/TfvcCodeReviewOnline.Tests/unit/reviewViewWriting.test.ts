import { beforeEach, describe, expect, it } from 'vitest';

import type { NewThreadAnchor } from '../../../src/TfvcCodeReviewOnline.Web/ts/clients/discussionRestClient';
import type { ReviewedFileContent } from '../../../src/TfvcCodeReviewOnline.Web/ts/clients/tfvcClient';
import {
    renderReview,
    resolveSelectedRange,
    rootCommentId,
    type ReviewViewModel,
    type ReviewWriter,
} from '../../../src/TfvcCodeReviewOnline.Web/ts/view/reviewView';
import {
    comment,
    flushAsyncWork,
    position,
    reviewContext,
    reviewedFile,
    SAMPLE_PATH,
    thread,
} from './support/reviewFixtures';

const BASE_TEXT = 'one\ntwo\nthree\nfour\n';
const REVIEWED_TEXT = 'one\nTWO\nthree\nfour\n';

let host: HTMLElement;

beforeEach(() => {
    document.body.textContent = '';
    host = document.createElement('div');
    document.body.appendChild(host);
});

/** Both versions of the sample file, which the view diffs itself. */
function fileContent(overrides: Partial<ReviewedFileContent> = {}): ReviewedFileContent {
    return {
        baseText: BASE_TEXT,
        reviewedText: REVIEWED_TEXT,
        isBinary: false,
        note: undefined,
        ...overrides,
    };
}

function model(overrides: Partial<ReviewViewModel> = {}): ReviewViewModel {
    return {
        reviewContext: reviewContext(),
        threads: [],
        files: [reviewedFile()],
        filesError: undefined,
        loadFileContent: () => Promise.resolve(fileContent()),
        ...overrides,
    };
}

interface RecordedReply {
    readonly threadId: number;
    readonly parentCommentId: number;
    readonly content: string;
}

interface RecordedThread {
    readonly anchor: NewThreadAnchor | undefined;
    readonly content: string;
}

function recordingWriter(overrides: Partial<ReviewWriter> = {}): ReviewWriter & {
    replies: RecordedReply[];
    createdThreads: RecordedThread[];
} {
    const replies: RecordedReply[] = [];
    const createdThreads: RecordedThread[] = [];
    return {
        replies,
        createdThreads,
        reply: (threadId, parentCommentId, content) => {
            replies.push({ threadId, parentCommentId, content });
            return Promise.resolve(comment({ id: 99, parentId: parentCommentId, content }));
        },
        createThread: (anchor, content) => {
            createdThreads.push({ anchor, content });
            return Promise.resolve(thread({
                id: 5000,
                itemPath: anchor?.itemPath,
                position: anchor?.position === undefined ? undefined : position({
                    startLine: anchor.position.startLine,
                    endLine: anchor.position.endLine,
                }),
                comments: [comment({ id: 1, content })],
            }));
        },
        ...overrides,
    };
}

function buttonsLabelled(label: string): readonly HTMLButtonElement[] {
    return Array.from(host.querySelectorAll('button'))
        .filter((button) => button.textContent === label);
}

function iconButtonTitled(title: string): HTMLButtonElement | undefined {
    return Array.from(host.querySelectorAll<HTMLButtonElement>(
        '.tfvc-code-review-online__icon-button'))
        .filter((button) => button.getAttribute('title') === title)[0];
}

function openForm(): HTMLElement {
    return host.querySelector('.tfvc-code-review-online__comment-form') as HTMLElement;
}

/** Types into an open comment form and submits it. */
function submitForm(form: HTMLElement, text: string): void {
    (form.querySelector('textarea') as HTMLTextAreaElement).value = text;
    (Array.from(form.querySelectorAll('button'))
        .filter((button) => button.textContent !== 'Cancel')[0]).click();
}

describe('rootCommentId', () => {
    it('picks the comment with no parent', () => {
        expect(rootCommentId(thread({
            comments: [comment({ id: 7 }), comment({ id: 8, parentId: 7 })],
        }))).toBe(7);
    });

    it('falls back to the first comment when every one claims a parent', () => {
        // A malformed thread should still be replyable rather than silently losing its Reply link.
        expect(rootCommentId(thread({
            comments: [comment({ id: 8, parentId: 99 })],
        }))).toBe(8);
    });

    it('has nothing to reply to when every comment was deleted', () => {
        expect(rootCommentId(thread({ comments: [comment({ isDeleted: true })] }))).toBeUndefined();
    });
});

describe('renderReview without a writer', () => {
    it('offers nothing to write', () => {
        // Which is also what happens when the review has no thread to take its artifact URI from,
        // since the service refuses to create a thread without one.
        renderReview(host, model({ threads: [thread({ itemPath: undefined })] }));

        // Specifically the comment affordances. The pane's own drawer toggle shares the icon-button
        // style and is always present, writer or not.
        expect(iconButtonTitled('Comment on this file')).toBeUndefined();
        expect(buttonsLabelled('Reply')).toEqual([]);
    });
});

describe('renderReview replying', () => {
    it('parents a reply to the thread root, the way Visual Studio does', async () => {
        // Verified against VS's own threads, which read back as id=2/parent=1, id=3/parent=1 -- a
        // flat thread rather than a chain of ever-deeper replies.
        const writer = recordingWriter();
        renderReview(host, model({
            writer,
            threads: [thread({
                itemPath: undefined,
                comments: [comment({ id: 1 }), comment({ id: 2, parentId: 1 })],
            })],
        }));

        buttonsLabelled('Reply')[0].click();
        submitForm(openForm(), 'Looks good');
        await flushAsyncWork();

        expect(writer.replies)
            .toEqual([{ threadId: 4001, parentCommentId: 1, content: 'Looks good' }]);
    });

    it('shows the new reply without reloading the review', async () => {
        // A reload would collapse every file the reader has opened and lose their place.
        const writer = recordingWriter();
        renderReview(host, model({ writer, threads: [thread({ itemPath: undefined })] }));

        buttonsLabelled('Reply')[0].click();
        submitForm(openForm(), 'Appended in place');
        await flushAsyncWork();

        expect(host.textContent).toContain('Appended in place');
        expect(host.querySelector('.tfvc-code-review-online__comment-form')).toBeNull();
    });

    it('keeps the typed text when the write fails, and says why', async () => {
        // A comment can be several careful sentences. A lapsed token is not a reason to lose it.
        const writer = recordingWriter({
            reply: () => Promise.reject(new Error('TF401027: no Contribute permission')),
        });
        renderReview(host, model({ writer, threads: [thread({ itemPath: undefined })] }));

        buttonsLabelled('Reply')[0].click();
        const form = openForm();
        submitForm(form, 'Worth keeping');
        await flushAsyncWork();

        expect((form.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Worth keeping');
        expect(form.textContent).toContain('TF401027');
    });

    it('refuses to post an empty comment', async () => {
        const writer = recordingWriter();
        renderReview(host, model({ writer, threads: [thread({ itemPath: undefined })] }));

        buttonsLabelled('Reply')[0].click();
        submitForm(openForm(), '   ');
        await flushAsyncWork();

        expect(writer.replies).toEqual([]);
    });

    it('abandons the form on cancel', () => {
        const writer = recordingWriter();
        renderReview(host, model({ writer, threads: [thread({ itemPath: undefined })] }));

        buttonsLabelled('Reply')[0].click();
        buttonsLabelled('Cancel')[0].click();

        expect(host.querySelector('.tfvc-code-review-online__comment-form')).toBeNull();
        expect(buttonsLabelled('Reply')).toHaveLength(1);
    });
});

describe('renderReview commenting on a file', () => {
    it('names the file and no line range', async () => {
        const writer = recordingWriter();
        renderReview(host, model({ writer, threads: [thread({ itemPath: undefined })] }));

        iconButtonTitled('Comment on this file')?.click();
        submitForm(openForm(), 'Is this file still needed?');
        await flushAsyncWork();

        expect(writer.createdThreads).toEqual([{
            anchor: { itemPath: SAMPLE_PATH },
            content: 'Is this file still needed?',
        }]);
        expect(host.textContent).toContain('Is this file still needed?');
    });

    it('reopens a file the reader had collapsed before showing the box', () => {
        // A form rendered inside a hidden body looks like nothing happened at all.
        const writer = recordingWriter();
        renderReview(host, model({ writer, threads: [] }));

        const body = host.querySelector('.tfvc-code-review-online__file-body') as HTMLElement;
        (host.querySelector('.tfvc-code-review-online__file-toggle') as HTMLButtonElement).click();
        expect(body.hidden).toBe(true);

        iconButtonTitled('Comment on this file')?.click();

        expect(body.hidden).toBe(false);
    });
});

describe('resolveSelectedRange', () => {
    function diffTable(): HTMLElement {
        return host.querySelector('.tfvc-code-review-online__diff') as HTMLElement;
    }

    /**
     * Selects from one cell to another, in that order.
     *
     * `setBaseAndExtent` rather than a Range: a Range normalizes its ends into document order, so it
     * cannot express a selection dragged upwards -- and the anchor and focus are exactly what the
     * code under test reads.
     */
    function select(from: Element, to: Element): void {
        const selection = document.getSelection() as Selection;
        selection.removeAllRanges();
        selection.setBaseAndExtent(from.firstChild ?? from, 0, to.firstChild ?? to, 0);
    }

    function cell(line: number, side: 'base' | 'reviewed'): Element {
        return host.querySelector(`[data-line="${line}"][data-side="${side}"]`) as Element;
    }

    async function renderWithDiff(mode?: 'inline' | 'sideBySide'): Promise<void> {
        renderReview(host, model({
            writer: recordingWriter(),
            threads: [thread({ itemPath: SAMPLE_PATH })],
            initialViewMode: mode,
        }));
        await flushAsyncWork();
    }

    it('reads a single line from a collapsed selection', async () => {
        // A plain click leaves a collapsed selection, so commenting on one line needs no separate
        // gesture from commenting on several.
        await renderWithDiff();
        select(cell(3, 'reviewed'), cell(3, 'reviewed'));

        expect(resolveSelectedRange(diffTable()))
            .toMatchObject({ side: 'reviewed', startLine: 3, endLine: 3 });
    });

    it('reads a dragged multi-line range', async () => {
        await renderWithDiff();
        select(cell(3, 'reviewed'), cell(4, 'reviewed'));

        expect(resolveSelectedRange(diffTable())).toMatchObject({ startLine: 3, endLine: 4 });
    });

    it('normalizes a selection dragged upwards', async () => {
        await renderWithDiff();
        select(cell(4, 'reviewed'), cell(3, 'reviewed'));

        expect(resolveSelectedRange(diffTable())).toMatchObject({ startLine: 3, endLine: 4 });
    });

    it('takes the side the selection started on', async () => {
        await renderWithDiff();
        select(cell(2, 'base'), cell(2, 'base'));

        expect(resolveSelectedRange(diffTable())).toMatchObject({ side: 'base', startLine: 2 });
    });

    it('narrows a selection spanning both sides to the side it started on', async () => {
        // A comment belongs to one buffer. Guessing which would be worse than being predictable.
        await renderWithDiff('sideBySide');
        select(cell(2, 'base'), cell(2, 'reviewed'));

        expect(resolveSelectedRange(diffTable()))
            .toMatchObject({ side: 'base', startLine: 2, endLine: 2 });
    });

    it('reports nothing when the selection is outside the diff', async () => {
        await renderWithDiff();
        const outside = host.querySelector('.tfvc-code-review-online__review-heading') as Element;
        select(outside, outside);

        expect(resolveSelectedRange(diffTable())).toBeUndefined();
    });
});

describe('renderReview commenting on a range', () => {
    it('offers a button for the selected lines and posts the range with character offsets', async () => {
        const writer = recordingWriter();
        renderReview(host, model({
            writer,
            threads: [thread({ itemPath: SAMPLE_PATH })],
        }));
        await flushAsyncWork();

        const table = host.querySelector('.tfvc-code-review-online__diff') as HTMLElement;
        const selection = document.getSelection() as Selection;
        selection.removeAllRanges();
        const range = document.createRange();
        const from = host.querySelector('[data-line="3"][data-side="reviewed"]') as Element;
        const to = host.querySelector('[data-line="4"][data-side="reviewed"]') as Element;
        range.setStart(from.firstChild ?? from, 0);
        range.setEnd(to.firstChild ?? to, 0);
        selection.addRange(range);

        table.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await flushAsyncWork();

        const button = iconButtonTitled('Comment on lines 3 to 4');
        expect(button).toBeDefined();

        button?.click();
        submitForm(openForm(), 'This block needs a test.');
        await flushAsyncWork();

        expect(writer.createdThreads).toHaveLength(1);
        const [created] = writer.createdThreads;
        expect(created.content).toBe('This block needs a test.');
        expect(created.anchor?.itemPath).toBe(SAMPLE_PATH);
        expect(created.anchor?.position).toMatchObject({
            startLine: 3,
            endLine: 4,
            side: 'reviewed',
        });
        // "one\r\nTWO\r\n" is 10 characters, so line 3 starts at 10 and line 5 at 10 + 7 + 6.
        expect(created.anchor?.position?.startCharPosition).toBe(10);
        expect(created.anchor?.position?.endCharPosition).toBe(23);
        expect(host.textContent).toContain('This block needs a test.');
    });

    it('takes the base path for a comment on the base side of a renamed file', async () => {
        // The base version lives under the old name, and a comment on it has to say so.
        const writer = recordingWriter();
        renderReview(host, model({
            writer,
            files: [reviewedFile({
                changeType: 'edit, rename',
                path: '$/ExampleProject/src/New.cs',
                basePath: '$/ExampleProject/src/Old.cs',
            })],
            threads: [thread({ itemPath: '$/ExampleProject/src/New.cs' })],
        }));
        await flushAsyncWork();

        const table = host.querySelector('.tfvc-code-review-online__diff') as HTMLElement;
        const cell = host.querySelector('[data-line="2"][data-side="base"]') as Element;
        const selection = document.getSelection() as Selection;
        selection.removeAllRanges();
        const range = document.createRange();
        range.setStart(cell.firstChild ?? cell, 0);
        range.setEnd(cell.firstChild ?? cell, 0);
        selection.addRange(range);

        table.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await flushAsyncWork();

        iconButtonTitled('Comment on line 2')?.click();
        submitForm(openForm(), 'Why was this dropped?');
        await flushAsyncWork();

        expect(writer.createdThreads[0].anchor?.itemPath).toBe('$/ExampleProject/src/Old.cs');
        expect(writer.createdThreads[0].anchor?.position?.side).toBe('base');
    });
});

describe('renderReview commenting from the gutter', () => {
    async function renderWithDiff(mode?: 'inline' | 'sideBySide'): Promise<ReviewWriter & {
        createdThreads: RecordedThread[];
    }> {
        const writer = recordingWriter();
        renderReview(host, model({
            writer,
            threads: [thread({ itemPath: SAMPLE_PATH })],
            initialViewMode: mode,
        }));
        await flushAsyncWork();
        return writer;
    }

    function hover(cell: Element): void {
        cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    }

    function gutterButton(): HTMLButtonElement | undefined {
        return host.querySelector<HTMLButtonElement>(
            '.tfvc-code-review-online__gutter .tfvc-code-review-online__icon-button') ?? undefined;
    }

    it('offers a comment button on the hovered line, with no selection needed', async () => {
        // A single click on one line is the common case, and it used to require deliberately
        // selecting text first.
        await renderWithDiff();

        expect(gutterButton()).toBeUndefined();

        hover(host.querySelector('[data-line="3"][data-side="reviewed"]') as Element);

        expect(gutterButton()?.getAttribute('title')).toBe('Comment on line 3');
    });

    it('puts the button in the gutter of the side being pointed at', async () => {
        // Not in a shared column at the left of the row: that offered a button beside the base
        // version while the pointer was over the reviewed one, which names the wrong side.
        await renderWithDiff('sideBySide');

        hover(host.querySelector('[data-line="3"][data-side="reviewed"]') as Element);

        expect(gutterButton()?.parentElement?.dataset.gutterSide).toBe('reviewed');
    });

    it('follows the pointer from one side to the other', async () => {
        await renderWithDiff('sideBySide');

        hover(host.querySelector('[data-line="2"][data-side="base"]') as Element);
        expect(gutterButton()?.parentElement?.dataset.gutterSide).toBe('base');

        hover(host.querySelector('[data-line="2"][data-side="reviewed"]') as Element);
        expect(gutterButton()?.parentElement?.dataset.gutterSide).toBe('reviewed');
    });

    it('comments on the single hovered line', async () => {
        const writer = await renderWithDiff();

        hover(host.querySelector('[data-line="3"][data-side="reviewed"]') as Element);
        gutterButton()?.click();
        submitForm(openForm(), 'Just this line.');
        await flushAsyncWork();

        expect(writer.createdThreads[0].anchor?.position).toMatchObject({
            startLine: 3,
            endLine: 3,
            side: 'reviewed',
        });
    });

    it('leaves the button alone while a selection is in force', async () => {
        // A selection says which lines are meant; a hover does not, and must not move a button the
        // reader is on their way to click.
        await renderWithDiff();

        const from = host.querySelector('[data-line="3"][data-side="reviewed"]') as Element;
        const to = host.querySelector('[data-line="4"][data-side="reviewed"]') as Element;
        const selection = document.getSelection() as Selection;
        selection.removeAllRanges();
        selection.setBaseAndExtent(from.firstChild ?? from, 0, to.firstChild ?? to, 0);

        const table = host.querySelector('.tfvc-code-review-online__diff') as HTMLElement;
        table.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await flushAsyncWork();
        expect(gutterButton()?.getAttribute('title')).toBe('Comment on lines 3 to 4');

        hover(host.querySelector('[data-line="1"][data-side="reviewed"]') as Element);

        expect(gutterButton()?.getAttribute('title')).toBe('Comment on lines 3 to 4');
    });
});

describe('renderReview unwrapped side by side', () => {
    async function render(): Promise<void> {
        renderReview(host, model({
            writer: recordingWriter(),
            threads: [thread({ itemPath: SAMPLE_PATH })],
            initialViewMode: 'sideBySide',
            initialWordWrap: false,
        }));
        await flushAsyncWork();
    }

    it('gives each version its own scrollbar', async () => {
        await render();

        const bars = host.querySelectorAll('.tfvc-code-review-online__scrollbar');
        expect(bars).toHaveLength(2);
    });

    it('does not scroll the box itself, which would move both versions together', async () => {
        await render();

        const diffHost = host.querySelector('.tfvc-code-review-online__diff-host') as HTMLElement;
        expect(diffHost.className).toContain('diff-host--nowrap');
        expect(diffHost.className).not.toContain('diff-host--scrollx');
    });

    it('scrolls the whole box in the layouts that have one code column', async () => {
        renderReview(host, model({
            threads: [thread({ itemPath: SAMPLE_PATH })],
            initialViewMode: 'inline',
            initialWordWrap: false,
        }));
        await flushAsyncWork();

        const diffHost = host.querySelector('.tfvc-code-review-online__diff-host') as HTMLElement;
        expect(diffHost.className).toContain('diff-host--scrollx');
        expect(host.querySelectorAll('.tfvc-code-review-online__scrollbar')).toHaveLength(0);
    });

    it('shifts only its own version when a scrollbar moves', async () => {
        await render();

        const [left] = Array.from(host.querySelectorAll<HTMLElement>(
            '.tfvc-code-review-online__scrollbar'));
        Object.defineProperty(left, 'scrollLeft', { value: 40, configurable: true });
        left.dispatchEvent(new Event('scroll'));

        const table = host.querySelector('.tfvc-code-review-online__diff') as HTMLElement;
        expect(table.style.getPropertyValue('--tfvc-left-scroll')).toBe('-40px');
        expect(table.style.getPropertyValue('--tfvc-right-scroll')).toBe('');
    });

    it('keeps the left scrollbar the same width as the column it drives', async () => {
        await render();

        const left = host.querySelector('.tfvc-code-review-online__scrollbar--left') as HTMLElement;
        expect(left.style.flexBasis).toBe('50%');
    });
});
