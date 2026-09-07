import { beforeEach, describe, expect, it } from 'vitest';

import type { ReviewedFileContent } from '../../../src/TfvcCodeReviewOnline.Web/ts/clients/tfvcClient';
import {
    describeThreadCount,
    findAdjacentDifference,
    findDifferenceRows,
    initialsOf,
    renderReview,
    resolveTargetUrl,
    type ReviewCloser,
    type ReviewViewModel,
} from '../../../src/TfvcCodeReviewOnline.Web/ts/view/reviewView';
import type { ReviewClosure } from '../../../src/TfvcCodeReviewOnline.Web/ts/clients/workItemContext';
import {
    author,
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

function text(): string {
    return host.textContent ?? '';
}

/**
 * The clickable part of each file header.
 *
 * Not the header itself: the header is a container, because the file-level comment button cannot be
 * nested inside the toggle button and still be a button.
 */
function fileHeaders(): readonly HTMLElement[] {
    return Array.from(host.querySelectorAll('.tfvc-code-review-online__file-toggle'));
}

function fileBodies(): readonly HTMLElement[] {
    return Array.from(host.querySelectorAll('.tfvc-code-review-online__file-body'));
}

/** The full paths, which the header carries as its tooltip rather than as a second line. */
function filePaths(): readonly string[] {
    return fileHeaders().map((header) => header.title);
}

function treeRows(): readonly HTMLElement[] {
    return Array.from(host.querySelectorAll('.tfvc-code-review-online__tree-row'));
}

/** Tree labels without the expand/collapse glyph, which shares the button with the name. */
function treeNames(): readonly string[] {
    return Array.from(host.querySelectorAll('.tfvc-code-review-online__tree-name'))
        .map((node) => node.textContent ?? '');
}

function treeRowNamed(name: string): HTMLElement {
    return treeRows().filter((row) => row.querySelector(
        '.tfvc-code-review-online__tree-name')?.textContent === name)[0];
}

function codeCellTexts(): readonly string[] {
    return Array.from(host.querySelectorAll('.tfvc-code-review-online__code'))
        .map((cell) => cell.textContent ?? '');
}

describe('describeThreadCount', () => {
    it('names the unresolved count when it differs from the total', () => {
        expect(describeThreadCount(3, 1)).toBe('3 threads, 1 unresolved');
    });

    it('says nothing about unresolved threads when every thread is unresolved', () => {
        // Which is every review on a TFVC collection, because nothing ever resolves a thread. The
        // count would otherwise be the total repeated, which reads as information and is not.
        expect(describeThreadCount(8, 8)).toBe('8 threads');
        expect(describeThreadCount(1, 1)).toBe('1 thread');
    });

    it('says nothing about unresolved threads when none are', () => {
        expect(describeThreadCount(3, 0)).toBe('3 threads');
    });
});

describe('initialsOf', () => {
    it('takes the first and last initial of a display name', () => {
        expect(initialsOf('Sample User')).toBe('SU');
        expect(initialsOf('Sample Middle User')).toBe('SU');
        expect(initialsOf('Sample')).toBe('S');
    });

    it('falls back to a placeholder for an identity with no name', () => {
        expect(initialsOf('')).toBe('?');
    });
});

describe('renderReview', () => {
    it('scopes everything it renders under a single root class', () => {
        renderReview(host, model());

        expect(host.children).toHaveLength(1);
        expect(host.children[0].className).toBe('tfvc-code-review-online');
    });

    it('names what is being reviewed, and folds the rest away', () => {
        renderReview(host, model({
            threads: [
                thread({ id: 1, status: 'active' }),
                thread({ id: 2, status: 'closed' }),
            ],
        }));

        // No title: the work item form already shows it directly above the tab.
        expect(text()).not.toContain('Adds retry handling around the import step');
        expect(text()).toContain('CodeReview_2026-04-07');

        // The counts are worth having and are read once, so they start folded away.
        const details = host.querySelector('.tfvc-code-review-online__review-details') as HTMLElement;
        expect(details.hidden).toBe(true);

        const toggle = host.querySelector(
            '.tfvc-code-review-online__details-toggle') as HTMLButtonElement;
        toggle.click();

        expect(details.hidden).toBe(false);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(details.textContent).toContain('Showing 1 file change');
        expect(details.textContent).toContain('2 threads, 1 unresolved');
    });

    it('folds the details away again', () => {
        renderReview(host, model({ threads: [] }));

        const details = host.querySelector('.tfvc-code-review-online__review-details') as HTMLElement;
        const toggle = host.querySelector(
            '.tfvc-code-review-online__details-toggle') as HTMLButtonElement;

        toggle.click();
        toggle.click();

        expect(details.hidden).toBe(true);
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });

    it('keeps the way through the review beside what is being reviewed', () => {
        // One row above both panes: the shelveset, then the differences, then the settings. It is
        // outside the pane that scrolls, so it stays put without having to be pinned.
        renderReview(host, model({ threads: [] }));

        const row = host.querySelector('.tfvc-code-review-online__heading-row') as HTMLElement;

        expect(row.querySelector('.tfvc-code-review-online__review-heading')).not.toBeNull();
        expect(Array.from(row.querySelectorAll('button'))
            .map((button) => button.getAttribute('title')))
            .toEqual([
                'Show what this review contains',
                'Previous difference',
                'Next difference',
                'Display settings',
            ]);
    });

    it('links the shelveset to version control', () => {
        renderReview(host, model({
            collectionUri: 'https://tfs.example.com/DefaultCollection',
            projectName: 'Example Project',
        }));

        const link = host.querySelector(
            '.tfvc-code-review-online__review-heading-name') as HTMLAnchorElement;
        // Only the name is a link -- the word in front of it is a label, not a destination.
        expect(link.textContent).toBe('CodeReview_2026-04-07');
        expect(link.getAttribute('href')).toBe(
            'https://tfs.example.com/DefaultCollection/Example%20Project/_versionControl/shelveset'
            + '?ss=CodeReview_2026-04-07%3B00000000-0000-4000-8000-000000000001');
    });

    it('leaves the target as plain text when no link can be built', () => {
        // Without a project there is nowhere to point, and a link that goes nowhere is worse than
        // none at all.
        renderReview(host, model({ collectionUri: undefined, projectName: undefined }));

        expect(host.querySelector('a.tfvc-code-review-online__review-heading-name')).toBeNull();
        expect(text()).toContain('CodeReview_2026-04-07');
    });

    it('describes a changeset review by its changeset number', () => {
        renderReview(host, model({
            reviewContext: reviewContext({
                target: { kind: 'changeset', changesetId: 23113 },
            }),
        }));

        expect(text()).toContain('Changeset 23113');
    });

    it('says plainly when a review has no comments', () => {
        renderReview(host, model());

        expect(text()).toContain('This review has no comments.');
    });

    it('shows review-level threads above the files', () => {
        renderReview(host, model({
            threads: [thread({
                itemPath: undefined,
                comments: [comment({ content: 'Please look at the retry count.' })],
            })],
        }));

        expect(text()).toContain('Please look at the retry count.');
        // The first h2 is the review's own heading; the section headings follow it.
        const headings = Array.from(host.querySelectorAll('h2')).map((node) => node.textContent);
        expect(headings[1]).toBe('Review');
    });
});

describe('renderReview file list', () => {
    it('lists every file once, in path order, all of them open', async () => {
        // One flat list rather than commented files first: the tree on the left is what gets you to
        // a particular file, so the list itself is better off in the order the paths sort in.
        renderReview(host, model({
            files: [
                reviewedFile({ path: '$/ExampleProject/src/Alpha.cs' }),
                reviewedFile({ path: '$/ExampleProject/src/Zeta.cs' }),
            ],
            threads: [thread({ itemPath: '$/ExampleProject/src/Zeta.cs' })],
        }));
        await flushAsyncWork();

        expect(text()).toContain('Files (2)');
        expect(text()).not.toContain('Files with comments');
        expect(filePaths()).toEqual([
            '$/ExampleProject/src/Alpha.cs',
            '$/ExampleProject/src/Zeta.cs',
        ]);
        expect(fileBodies().map((body) => body.hidden)).toEqual([false, false]);
    });

    it('shows a diff without anything having to be clicked', async () => {
        renderReview(host, model({ threads: [] }));
        await flushAsyncWork();

        expect(fileBodies()[0].hidden).toBe(false);
        expect(codeCellTexts()).toContain('TWO');
        expect(fileHeaders()[0].getAttribute('aria-expanded')).toBe('true');
    });

    it('waits until a file nears the viewport before fetching it', async () => {
        // Every file is open, so without this a review of ninety files would fire off a hundred and
        // eighty requests before the reader had looked at anything. jsdom has no
        // IntersectionObserver, so the behavior is exercised against a stand-in.
        const observed: Element[] = [];
        let trigger: (() => void) | undefined;

        class FakeIntersectionObserver {
            public constructor(private readonly callback: (entries: unknown[]) => void) {}
            public observe(target: Element): void {
                observed.push(target);
                trigger = () => this.callback([{ isIntersecting: true, target }]);
            }
            public disconnect(): void { /* nothing to release in the stand-in */ }
        }

        const original = (globalThis as Record<string, unknown>).IntersectionObserver;
        (globalThis as Record<string, unknown>).IntersectionObserver = FakeIntersectionObserver;

        try {
            const requested: string[] = [];
            renderReview(host, model({
                threads: [],
                loadFileContent: (file) => {
                    requested.push(file.path);
                    return Promise.resolve(fileContent());
                },
            }));
            await flushAsyncWork();

            expect(observed).toHaveLength(1);
            expect(requested).toEqual([]);

            trigger?.();
            await flushAsyncWork();

            expect(requested).toEqual([SAMPLE_PATH]);
            expect(codeCellTexts()).toContain('TWO');
        } finally {
            (globalThis as Record<string, unknown>).IntersectionObserver = original;
        }
    });

    it('fetches a file immediately where the browser cannot say when it is visible', async () => {
        // A slow load is recoverable; a file that never loads is not.
        const requested: string[] = [];
        renderReview(host, model({
            threads: [],
            loadFileContent: (file) => {
                requested.push(file.path);
                return Promise.resolve(fileContent());
            },
        }));
        await flushAsyncWork();

        expect(requested).toEqual([SAMPLE_PATH]);
    });

    it('fetches a file only once, however often it is collapsed and reopened', async () => {
        let calls = 0;
        renderReview(host, model({
            threads: [],
            loadFileContent: () => {
                calls++;
                return Promise.resolve(fileContent());
            },
        }));
        await flushAsyncWork();

        fileHeaders()[0].click();
        fileHeaders()[0].click();
        fileHeaders()[0].click();
        await flushAsyncWork();

        expect(calls).toBe(1);
    });

    it('collapses and reopens a file on demand', async () => {
        renderReview(host, model({ threads: [] }));
        await flushAsyncWork();

        fileHeaders()[0].click();
        expect(fileBodies()[0].hidden).toBe(true);
        expect(fileHeaders()[0].getAttribute('aria-expanded')).toBe('false');

        fileHeaders()[0].click();
        expect(fileBodies()[0].hidden).toBe(false);
    });

    it('badges a file with its thread counts', () => {
        renderReview(host, model({
            threads: [
                thread({ id: 1, status: 'active' }),
                thread({ id: 2, status: 'closed' }),
            ],
        }));

        const badge = host.querySelector('.tfvc-code-review-online__file-badge');
        expect(badge?.textContent).toBe('2 threads, 1 unresolved');
        expect(badge?.className).toContain('file-badge--unresolved');
    });

    it('notes what happened to a file that was added, deleted, or renamed', async () => {
        renderReview(host, model({
            files: [reviewedFile({
                changeType: 'edit, rename',
                path: '$/ExampleProject/src/New.cs',
                basePath: '$/ExampleProject/src/Old.cs',
            })],
            threads: [thread({ itemPath: '$/ExampleProject/src/New.cs' })],
        }));
        await flushAsyncWork();

        expect(text()).toContain('Renamed from $/ExampleProject/src/Old.cs');
    });
});

describe('renderReview comments', () => {
    it('anchors a thread beneath the line it refers to', async () => {
        renderReview(host, model({
            threads: [thread({
                position: position({ startLine: 3, endLine: 3 }),
                comments: [comment({ content: 'Why is this here?' })],
            })],
        }));
        await flushAsyncWork();

        const threadRow = host.querySelector('.tfvc-code-review-online__thread-row');
        expect(threadRow?.textContent).toContain('Why is this here?');

        const anchorRow = threadRow?.previousElementSibling;
        expect(anchorRow?.querySelector('.tfvc-code-review-online__code')?.textContent).toBe('three');
        expect(threadRow?.textContent).toContain('Line 3');
    });

    it('anchors a base-side thread to the removed line and says which version it is', async () => {
        renderReview(host, model({
            threads: [thread({
                position: position({ startLine: 2, endLine: 2, positionContext: 'LeftBuffer' }),
                comments: [comment({ content: 'Why was this dropped?' })],
            })],
        }));
        await flushAsyncWork();

        const threadRow = host.querySelector('.tfvc-code-review-online__thread-row');
        const anchorRow = threadRow?.previousElementSibling;
        expect(anchorRow?.className).toContain('row--removed');
        expect(anchorRow?.querySelector('.tfvc-code-review-online__code')?.textContent).toBe('two');
        expect(threadRow?.textContent).toContain('base version');
    });

    it('nests replies beneath the comment they answer', async () => {
        renderReview(host, model({
            threads: [thread({
                position: position(),
                comments: [
                    comment({ id: 1, content: 'Root question.' }),
                    comment({ id: 2, parentId: 1, content: 'First reply.' }),
                    comment({ id: 3, parentId: 2, content: 'Reply to the reply.' }),
                ],
            })],
        }));
        await flushAsyncWork();

        const comments = Array.from(host.querySelectorAll('.tfvc-code-review-online__comment'));
        expect(comments.map((node) => node.textContent?.includes('Root question.'))[0]).toBe(true);
        expect((comments[0] as HTMLElement).style.marginLeft).toBe('');
        expect((comments[1] as HTMLElement).style.marginLeft).toBe('22px');
        expect((comments[2] as HTMLElement).style.marginLeft).toBe('44px');
    });

    it('shows a file-level thread above the diff rather than against a line', async () => {
        renderReview(host, model({
            threads: [thread({ comments: [comment({ content: 'Is this file still needed?' })] })],
        }));
        await flushAsyncWork();

        expect(host.querySelector('.tfvc-code-review-online__thread-row')).toBeNull();
        expect(text()).toContain('Is this file still needed?');
    });

    it('renders comment text as text, never as markup', async () => {
        // Review comments are user input. Rendering them as HTML would make every review an
        // injection vector, so this asserts the escaping rather than trusting it.
        renderReview(host, model({
            threads: [thread({
                comments: [comment({ content: '<img src=x onerror="alert(1)">' })],
            })],
        }));
        await flushAsyncWork();

        expect(host.querySelector('img')).toBeNull();
        expect(text()).toContain('<img src=x onerror="alert(1)">');
    });

    it('leaves out a comment its author deleted', async () => {
        renderReview(host, model({
            threads: [thread({
                comments: [
                    comment({ id: 1, content: 'Kept.' }),
                    comment({ id: 2, content: 'Withdrawn.', isDeleted: true }),
                ],
            })],
        }));
        await flushAsyncWork();

        expect(text()).toContain('Kept.');
        expect(text()).not.toContain('Withdrawn.');
    });

    it('shows an avatar when the author has one and initials when they do not', async () => {
        renderReview(host, model({
            threads: [
                thread({
                    id: 1,
                    comments: [comment({ author: author({ imageUrl: 'https://tfs.example.com/avatar' }) })],
                }),
                thread({
                    id: 2,
                    comments: [comment({ author: author({ displayName: 'Sample Reviewer', imageUrl: undefined }) })],
                }),
            ],
        }));
        await flushAsyncWork();

        expect(host.querySelector('img.tfvc-code-review-online__avatar')?.getAttribute('src'))
            .toBe('https://tfs.example.com/avatar');
        expect(host.querySelector('.tfvc-code-review-online__avatar--initials')?.textContent)
            .toBe('SR');
    });
});

describe('renderReview when something is missing', () => {
    it('keeps a comment whose line is gone, and says why it is not beside the code', async () => {
        renderReview(host, model({
            threads: [thread({
                position: position({ startLine: 900, endLine: 900 }),
                comments: [comment({ content: 'This anchor is stale.' })],
            })],
        }));
        await flushAsyncWork();

        expect(text()).toContain('This anchor is stale.');
        expect(text()).toContain('lines that are in neither version');
        expect(host.querySelector('.tfvc-code-review-online__thread-row')).toBeNull();
    });

    it('keeps the comments when the diff cannot be loaded', async () => {
        renderReview(host, model({
            threads: [thread({
                position: position(),
                comments: [comment({ content: 'Still worth reading.' })],
            })],
            loadFileContent: () => Promise.reject(new Error('TF14021: shelveset not found')),
        }));
        await flushAsyncWork();

        expect(text()).toContain('TF14021: shelveset not found');
        expect(text()).toContain('Still worth reading.');
    });

    it('keeps the comments when there is no diff to show at all', async () => {
        renderReview(host, model({
            threads: [thread({
                position: position(),
                comments: [comment({ content: 'A comment on a binary file.' })],
            })],
            loadFileContent: () => Promise.resolve(fileContent({ isBinary: true })),
        }));
        await flushAsyncWork();

        expect(text()).toContain('binary file');
        expect(text()).toContain('A comment on a binary file.');
        expect(text()).toContain('Line 3');
    });

    it('shows the comments when the file list itself could not be read', async () => {
        renderReview(host, model({
            files: [],
            filesError: 'The shelveset no longer exists.',
            threads: [thread({
                position: position(),
                comments: [comment({ content: 'The review outlived the shelveset.' })],
            })],
        }));
        await flushAsyncWork();

        expect(text()).toContain('The shelveset no longer exists.');
        expect(text()).toContain('The review outlived the shelveset.');
    });

    it('accounts for a commented file that is not among the review changes', async () => {
        renderReview(host, model({
            files: [reviewedFile({ path: '$/ExampleProject/src/Other.cs' })],
            threads: [thread({
                itemPath: SAMPLE_PATH,
                comments: [comment({ content: 'Removed from the shelveset later.' })],
            })],
        }));
        await flushAsyncWork();

        expect(text()).toContain('Comments on files outside this review (1)');
        expect(text()).toContain('Removed from the shelveset later.');
    });
});

describe('renderReview collapsing', () => {
    const longBase = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    const longReviewed = longBase.replace('line 20\n', 'changed\n');

    function longFileModel(overrides: Partial<ReviewViewModel> = {}): ReviewViewModel {
        return model({
            threads: [thread({ itemPath: SAMPLE_PATH })],
            loadFileContent: () => Promise.resolve(
                fileContent({ baseText: longBase, reviewedText: longReviewed })),
            ...overrides,
        });
    }

    it('hides long runs of unchanged lines behind an expander', async () => {
        renderReview(host, longFileModel());
        await flushAsyncWork();

        const expanders = Array.from(host.querySelectorAll('.tfvc-code-review-online__expander'));
        expect(expanders.length).toBeGreaterThan(0);
        expect(codeCellTexts()).not.toContain('line 1');
        expect(codeCellTexts()).toContain('changed');
    });

    it('states the column widths independently of the first row', async () => {
        // Under table-layout: fixed the browser takes column widths from the first row, and here the
        // first row is a single cell spanning every column. Without a colgroup it splits the table
        // into equal parts, leaving the code in the last one behind enormous line-number columns --
        // and nothing about the markup looks wrong when that happens.
        renderReview(host, longFileModel());
        await flushAsyncWork();

        const columns = Array.from(host.querySelectorAll('.tfvc-code-review-online__diff col'));
        expect(columns).toHaveLength(4);
        // Both line-number gutters, the change marker, then the code taking what remains.
        expect(columns.map((column) => (column as HTMLElement).style.width))
            .toEqual(['3.6em', '3.6em', '1.2em', '']);

        const firstRow = host.querySelector('.tfvc-code-review-online__diff tbody tr');
        expect(firstRow?.querySelector('td')?.colSpan).toBe(4);
    });

    it('reveals the hidden lines when the expander is used', async () => {
        renderReview(host, longFileModel());
        await flushAsyncWork();

        (host.querySelector('.tfvc-code-review-online__expander') as HTMLButtonElement).click();

        expect(codeCellTexts()).toContain('line 1');
    });

    it('never hides a line a comment is anchored to', async () => {
        // An expander over a commented line would leave the reader looking at a comment with no way
        // to see what it refers to.
        renderReview(host, longFileModel({
            threads: [thread({
                itemPath: SAMPLE_PATH,
                position: position({ startLine: 2, endLine: 2 }),
                comments: [comment({ content: 'Early comment.' })],
            })],
        }));
        await flushAsyncWork();

        expect(codeCellTexts()).toContain('line 2');
        expect(host.querySelector('.tfvc-code-review-online__thread-row')?.textContent)
            .toContain('Early comment.');
    });
});

/*
 * There is no test here for frame sizing, and that is not an oversight.
 *
 * The tab does not size its own frame: the host renders it in a fixed-height container with
 * `overflow: hidden`, so the frame is left alone and the review scrolls within it. That behavior is
 * entirely CSS, and jsdom reports every scrollHeight as 0, so a test over it would assert nothing
 * while looking as though it did. It is verified in a browser instead -- see wwwroot/css/app.css.
 */

describe('renderReview navigation tree', () => {
    it('renders the review files as a tree, with folder chains collapsed', () => {
        renderReview(host, model({
            files: [
                reviewedFile({ path: '$/ExampleProject/src/One/A.cs' }),
                reviewedFile({ path: '$/ExampleProject/src/Two/B.cs' }),
            ],
            threads: [],
        }));

        expect(treeNames())
            .toEqual(['$/ExampleProject/src', 'One', 'A.cs', 'Two', 'B.cs']);
    });

    it('badges tree entries with their thread counts', () => {
        renderReview(host, model({
            files: [reviewedFile()],
            threads: [thread({ id: 1 }), thread({ id: 2 })],
        }));

        const badges = Array.from(host.querySelectorAll('.tfvc-code-review-online__tree-badge'));
        expect(badges.map((badge) => badge.textContent)).toContain('2');
    });

    it('marks the chosen file and leaves the previous one unmarked', () => {
        renderReview(host, model({
            files: [
                reviewedFile({ path: '$/ExampleProject/src/A.cs' }),
                reviewedFile({ path: '$/ExampleProject/src/B.cs' }),
            ],
            threads: [],
        }));

        const files = treeRows().filter((row) => row.classList.contains(
            'tfvc-code-review-online__tree-row--file'));
        files[0].click();
        expect(files[0].className).toContain('tree-row--selected');

        files[1].click();
        expect(files[0].className).not.toContain('tree-row--selected');
        expect(files[1].className).toContain('tree-row--selected');
    });

    it('collapses and reopens a folder', () => {
        renderReview(host, model({
            files: [
                reviewedFile({ path: '$/ExampleProject/src/One/A.cs' }),
                reviewedFile({ path: '$/ExampleProject/src/Two/B.cs' }),
            ],
            threads: [],
        }));

        const folder = treeRowNamed('One');
        // The row sits in a line with its actions, and the line inside the item that holds the
        // folder's children.
        const group = folder.closest('li')?.querySelector('ul') as HTMLElement;

        folder.click();
        expect(group.hidden).toBe(true);

        folder.click();
        expect(group.hidden).toBe(false);
    });

    it('says so when there are no files to navigate', () => {
        renderReview(host, model({ files: [], filesError: 'The shelveset no longer exists.' }));

        const tree = host.querySelector('.tfvc-code-review-online__tree') as HTMLElement;
        expect(tree.textContent).toContain('No files to show.');
    });

    it('leaves out paths that are not part of the review', () => {
        // Those have their own section, and listing them in a tree of "files in this review" would
        // say something untrue about them.
        renderReview(host, model({
            files: [reviewedFile({ path: '$/ExampleProject/src/Present.cs' })],
            threads: [thread({ itemPath: '$/ExampleProject/src/Gone.cs' })],
        }));

        const tree = host.querySelector('.tfvc-code-review-online__tree') as HTMLElement;
        expect(tree.textContent).toContain('Present.cs');
        expect(tree.textContent).not.toContain('Gone.cs');
        expect(text()).toContain('Comments on files outside this review (1)');
    });
});

/**
 * The menu is attached to the document, not inside the host, because it is positioned against the
 * button that opened it and would otherwise be clipped by the pane that scrolls.
 */
function menuItem(label: string): HTMLButtonElement {
    return Array.from(document.querySelectorAll<HTMLButtonElement>(
        '.tfvc-code-review-online__menu-item'))
        .filter((button) => button.querySelector(
            '.tfvc-code-review-online__menu-label')?.textContent === label)[0];
}

function menuLabels(): readonly string[] {
    return Array.from(document.querySelectorAll('.tfvc-code-review-online__menu-label'))
        .map((node) => node.textContent ?? '');
}

/** Every button that opens a menu, found by the tooltip that names what the menu is for. */
function buttonsTitled(title: string): readonly HTMLButtonElement[] {
    return Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .filter((button) => button.getAttribute('title') === title);
}

describe('renderReview per-file display settings', () => {
    function openMenuFor(index = 0): void {
        buttonsTitled('Display settings for this file')[index].click();
    }

    it('shows nothing until the gear is used', async () => {
        // A review of ninety files would otherwise carry ninety copies of six controls from the
        // moment it loads, for a menu most files never need.
        renderReview(host, model({ threads: [] }));
        await flushAsyncWork();

        expect(document.querySelector('.tfvc-code-review-online__menu')).toBeNull();

        openMenuFor();

        expect(document.querySelector('.tfvc-code-review-online__menu')).not.toBeNull();
        expect(menuLabels()).toEqual([
            'Inline mode',
            'Side-by-side mode',
            'Left file only',
            'Right file only',
            'Wrap long lines',
            'Ignore trim whitespace',
            'Copy full path',
        ]);
    });

    it('ticks the settings currently in force', async () => {
        renderReview(host, model({ threads: [], initialViewMode: 'sideBySide' }));
        await flushAsyncWork();

        openMenuFor();

        expect(menuItem('Side-by-side mode').getAttribute('aria-checked')).toBe('true');
        expect(menuItem('Inline mode').getAttribute('aria-checked')).toBe('false');
        // Wrapping is on by default, and the menu should say so.
        expect(menuItem('Wrap long lines').getAttribute('aria-checked')).toBe('true');
    });

    it('closes when an item is chosen', async () => {
        renderReview(host, model({ threads: [] }));
        await flushAsyncWork();

        openMenuFor();
        menuItem('Side-by-side mode').click();
        await flushAsyncWork();

        expect(document.querySelector('.tfvc-code-review-online__menu')).toBeNull();
    });

    it('overrides the layout for that file alone', async () => {
        renderReview(host, model({
            files: [
                reviewedFile({ path: '$/ExampleProject/src/A.cs' }),
                reviewedFile({ path: '$/ExampleProject/src/B.cs' }),
            ],
            threads: [],
            initialViewMode: 'inline',
        }));
        await flushAsyncWork();

        openMenuFor(0);
        menuItem('Side-by-side mode').click();
        await flushAsyncWork();

        const diffs = Array.from(host.querySelectorAll('.tfvc-code-review-online__diff'));
        expect(diffs[0].className).toContain('diff--sideBySide');
        expect(diffs[1].className).toContain('diff--inline');
    });

    it('overrides wrapping for that file alone', async () => {
        renderReview(host, model({ threads: [] }));
        await flushAsyncWork();

        openMenuFor();
        menuItem('Wrap long lines').click();
        await flushAsyncWork();

        // Wrapping lives on the file's own diff host, which is also what scrolls sideways.
        const diffHost = host.querySelector('.tfvc-code-review-online__diff-host') as HTMLElement;
        expect(diffHost.className).toContain('diff-host--nowrap');
    });

    it('re-diffs that file when whitespace is ignored for it', async () => {
        renderReview(host, model({
            threads: [],
            loadFileContent: () => Promise.resolve(fileContent({
                baseText: '    a\n',
                reviewedText: '        a\n',
            })),
        }));
        await flushAsyncWork();

        const changedRows = (): number => host.querySelectorAll(
            '.tfvc-code-review-online__row--removed, .tfvc-code-review-online__row--added').length;

        // Re-indented, so the line counts as both removed and added.
        expect(changedRows()).toBe(2);

        openMenuFor();
        menuItem('Ignore trim whitespace').click();
        await flushAsyncWork();

        // Now unchanged -- and with nothing left to show, it collapses behind an expander.
        expect(changedRows()).toBe(0);
        expect(text()).toContain('Show 1 unchanged line');
    });

    it('goes back to the tab settings when asked', async () => {
        renderReview(host, model({ threads: [], initialViewMode: 'inline' }));
        await flushAsyncWork();

        openMenuFor();
        menuItem('Side-by-side mode').click();
        await flushAsyncWork();
        expect(host.querySelector('.tfvc-code-review-online__diff')?.className)
            .toContain('diff--sideBySide');

        openMenuFor();
        menuItem('Use the settings above').click();
        await flushAsyncWork();

        expect(host.querySelector('.tfvc-code-review-online__diff')?.className)
            .toContain('diff--inline');
    });

    it('offers no reset until something has been overridden', async () => {
        renderReview(host, model({ threads: [] }));
        await flushAsyncWork();

        openMenuFor();

        expect(menuLabels()).not.toContain('Use the settings above');
    });
});
describe('renderReview closing a review', () => {
    /** Records what it was asked to close, and lets the test decide when the save finishes. */
    function recordingCloser(): ReviewCloser & {
        readonly calls: { closure: string; comment: string }[];
        fail?: string;
    } {
        const closer = {
            calls: [] as { closure: string; comment: string }[],
            fail: undefined as string | undefined,
            close: (closure: ReviewClosure, comment: string) => {
                closer.calls.push({ closure, comment });
                return closer.fail === undefined
                    ? Promise.resolve()
                    : Promise.reject(new Error(closer.fail));
            },
        };
        return closer;
    }

    function closeButton(): HTMLButtonElement | undefined {
        return buttonsTitled('Close review')[0]
            ?? Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
                .filter((button) => button.textContent?.startsWith('Close review'))[0];
    }

    function panelButton(label: string): HTMLButtonElement {
        return Array.from(host.querySelectorAll<HTMLButtonElement>(
            '.tfvc-code-review-online__close-panel button'))
            .filter((button) => button.textContent === label)[0];
    }

    it('offers Visual Studio\'s two ways to close', () => {
        renderReview(host, model({ threads: [], closer: recordingCloser() }));

        closeButton()?.click();

        expect(menuLabels()).toEqual(['Complete', 'Abandon']);
    });

    it('points its caret down, as a control that opens a list does', () => {
        renderReview(host, model({ threads: [], closer: recordingCloser() }));

        expect(host.querySelector('.tfvc-code-review-online__text-button-caret')?.textContent)
            .toBe('▾');
    });

    it('offers nothing on a review that is already closed', () => {
        // The work item type defines no transition out of Closed, so a control here would be an
        // offer the server refuses.
        renderReview(host, model({
            threads: [],
            closer: recordingCloser(),
            reviewContext: reviewContext({
                state: 'Closed',
                closedStatus: 'Checked-in',
                isClosed: true,
            }),
        }));

        expect(closeButton()).toBeUndefined();
        expect(host.querySelector('.tfvc-code-review-online__review-state')?.textContent)
            .toBe('Closed (Checked-in)');
    });

    it('offers nothing when the host cannot write to the work item', () => {
        renderReview(host, model({ threads: [], closer: undefined }));

        expect(closeButton()).toBeUndefined();
    });

    it('asks before closing, rather than closing from the menu', async () => {
        // Closing cannot be undone, and this is two clicks from a menu that also holds harmless
        // things.
        const closer = recordingCloser();
        renderReview(host, model({ threads: [], closer }));

        closeButton()?.click();
        menuItem('Abandon').click();

        expect(closer.calls).toHaveLength(0);
        expect(host.querySelector('.tfvc-code-review-online__close-panel')?.textContent)
            .toContain('cannot be reopened');

        panelButton('Abandon review').click();
        await flushAsyncWork();

        expect(closer.calls).toEqual([{ closure: 'abandoned', comment: '' }]);
    });

    it('passes on a closing note', async () => {
        const closer = recordingCloser();
        renderReview(host, model({ threads: [], closer }));

        closeButton()?.click();
        menuItem('Complete').click();

        const note = host.querySelector(
            '.tfvc-code-review-online__close-panel textarea') as HTMLTextAreaElement;
        note.value = 'Checked in as changeset 23120.';
        panelButton('Complete review').click();
        await flushAsyncWork();

        expect(closer.calls).toEqual([{
            closure: 'checkedIn',
            comment: 'Checked in as changeset 23120.',
        }]);
    });

    it('says what the review became, and stops offering to close it', async () => {
        const closer = recordingCloser();
        renderReview(host, model({ threads: [], closer }));

        closeButton()?.click();
        menuItem('Abandon').click();
        panelButton('Abandon review').click();
        await flushAsyncWork();

        expect(closeButton()).toBeUndefined();
        expect(host.querySelector('.tfvc-code-review-online__review-state')?.textContent)
            .toBe('Closed (Abandoned)');
    });

    it('keeps the note and explains a refusal', async () => {
        const closer = recordingCloser();
        closer.fail = 'TF237121: The work item is locked.';
        renderReview(host, model({ threads: [], closer }));

        closeButton()?.click();
        menuItem('Complete').click();

        const note = host.querySelector(
            '.tfvc-code-review-online__close-panel textarea') as HTMLTextAreaElement;
        note.value = 'Two careful sentences.';
        panelButton('Complete review').click();
        await flushAsyncWork();

        expect(host.querySelector('.tfvc-code-review-online__close-panel')?.textContent)
            .toContain('TF237121');
        // Whatever refused the close, retyping the note is not the fix.
        expect(note.value).toBe('Two careful sentences.');
        expect(closeButton()).not.toBeUndefined();
    });
});

describe('renderReview display settings', () => {
    function openViewMenu(): void {
        buttonsTitled('Display settings')[0].click();
    }

    it('offers the tab-wide settings behind the toolbar gear', async () => {
        // The same choices as a file's own menu, minus the two that only make sense per file.
        renderReview(host, model({ threads: [] }));
        await flushAsyncWork();

        openViewMenu();

        expect(menuLabels()).toEqual([
            'Inline mode',
            'Side-by-side mode',
            'Left file only',
            'Right file only',
            'Wrap long lines',
            'Ignore trim whitespace',
        ]);
    });

    it('moves every file that has no opinion of its own', async () => {
        renderReview(host, model({
            files: [
                reviewedFile({ path: '$/ExampleProject/src/A.cs' }),
                reviewedFile({ path: '$/ExampleProject/src/B.cs' }),
            ],
            threads: [],
            initialViewMode: 'inline',
        }));
        await flushAsyncWork();

        openViewMenu();
        menuItem('Side-by-side mode').click();
        await flushAsyncWork();

        expect(Array.from(host.querySelectorAll('.tfvc-code-review-online__diff'))
            .map((diff) => diff.className))
            .toEqual([
                expect.stringContaining('diff--sideBySide'),
                expect.stringContaining('diff--sideBySide'),
            ]);
    });

    it('reports each choice so it can be remembered for next time', async () => {
        const modes: string[] = [];
        const wraps: boolean[] = [];
        const whitespace: boolean[] = [];

        renderReview(host, model({
            threads: [],
            onViewModeChanged: (mode) => { modes.push(mode); },
            onWordWrapChanged: (wrap) => { wraps.push(wrap); },
            onIgnoreWhitespaceChanged: (ignore) => { whitespace.push(ignore); },
        }));
        await flushAsyncWork();

        openViewMenu();
        menuItem('Left file only').click();
        openViewMenu();
        menuItem('Wrap long lines').click();
        openViewMenu();
        menuItem('Ignore trim whitespace').click();
        await flushAsyncWork();

        expect(modes).toEqual(['base']);
        // Both were toggled from their defaults: wrapping on, whitespace counted.
        expect(wraps).toEqual([false]);
        expect(whitespace).toEqual([true]);
    });

    it('leaves a file that has been given its own settings alone', async () => {
        renderReview(host, model({
            files: [
                reviewedFile({ path: '$/ExampleProject/src/A.cs' }),
                reviewedFile({ path: '$/ExampleProject/src/B.cs' }),
            ],
            threads: [],
            initialViewMode: 'inline',
        }));
        await flushAsyncWork();

        buttonsTitled('Display settings for this file')[0].click();
        menuItem('Left file only').click();
        await flushAsyncWork();

        openViewMenu();
        menuItem('Side-by-side mode').click();
        await flushAsyncWork();

        const diffs = Array.from(host.querySelectorAll('.tfvc-code-review-online__diff'));
        expect(diffs[0].className).toContain('diff--base');
        expect(diffs[1].className).toContain('diff--sideBySide');
    });
});

describe('findAdjacentDifference', () => {
    const offsets = [100, 400, 900];

    it('moves to the first difference below where the reader is', () => {
        expect(findAdjacentDifference(offsets, 0, 'next')).toBe(0);
        expect(findAdjacentDifference(offsets, 100, 'next')).toBe(1);
        expect(findAdjacentDifference(offsets, 500, 'next')).toBe(2);
    });

    it('moves to the last difference above where the reader is', () => {
        expect(findAdjacentDifference(offsets, 900, 'previous')).toBe(1);
        expect(findAdjacentDifference(offsets, 401, 'previous')).toBe(0);
    });

    it('treats being all but exactly on a difference as being on it', () => {
        // Scrolling to a difference does not land on its offset to the pixel, and without this the
        // button would put the reader back on the one they are already looking at.
        expect(findAdjacentDifference(offsets, 102, 'next')).toBe(1);
        expect(findAdjacentDifference(offsets, 98, 'previous')).toBeUndefined();
    });

    it('stops at the ends rather than wrapping around', () => {
        expect(findAdjacentDifference(offsets, 1000, 'next')).toBeUndefined();
        expect(findAdjacentDifference(offsets, 0, 'previous')).toBeUndefined();
        expect(findAdjacentDifference([], 0, 'next')).toBeUndefined();
    });
});

describe('findDifferenceRows', () => {
    it('counts a run of changed lines as one difference', async () => {
        // Two lines rewritten is one edit to look at, not four stops -- inline puts the removed
        // lines and the added ones in four adjacent rows.
        renderReview(host, model({
            threads: [],
            loadFileContent: () => Promise.resolve(fileContent({
                baseText: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n',
                reviewedText: 'one\nTWO\nTHREE\nfour\nfive\nsix\nseven\nEIGHT\n',
            })),
        }));
        await flushAsyncWork();

        // The two rewrites are separated by unchanged lines, so they are two differences.
        expect(findDifferenceRows(host)).toHaveLength(2);
    });

    it('counts a side-by-side row holding both a removal and an addition once', async () => {
        renderReview(host, model({ threads: [], initialViewMode: 'sideBySide' }));
        await flushAsyncWork();

        expect(findDifferenceRows(host)).toHaveLength(1);
    });

    it('finds nothing in a review with no differences on the page', () => {
        renderReview(host, model({ threads: [], files: [] }));

        expect(findDifferenceRows(host)).toHaveLength(0);
    });

    it('offers a way to step through them', async () => {
        renderReview(host, model({ threads: [] }));
        await flushAsyncWork();

        expect(buttonsTitled('Previous difference')).toHaveLength(1);
        expect(buttonsTitled('Next difference')).toHaveLength(1);
    });
});

describe('renderReview file header', () => {
    it('leads with the file name and keeps the path as a tooltip', async () => {
        // The path is what tells two files of the same name apart, but it is the name being looked
        // for -- so the name is what carries the weight, and a line of grey path text above every
        // file in the review is a cost paid on all of them for something wanted on a few.
        renderReview(host, model({ threads: [] }));
        await flushAsyncWork();

        expect(host.querySelector('.tfvc-code-review-online__file-name')?.textContent)
            .toBe('Sample.cs');
        expect(fileHeaders()[0].title).toBe(SAMPLE_PATH);
        expect(text()).not.toContain(SAMPLE_PATH);
    });

    it('counts the changed lines once the diff has been built', async () => {
        renderReview(host, model({ threads: [] }));
        await flushAsyncWork();

        // BASE_TEXT and REVIEWED_TEXT differ by one line.
        expect(host.querySelector('.tfvc-code-review-online__file-count-added')?.textContent)
            .toBe('+1');
        expect(host.querySelector('.tfvc-code-review-online__file-count-removed')?.textContent)
            .toBe('-1');
    });

    it('says nothing about an ordinary edit, which the counts already describe', async () => {
        renderReview(host, model({ threads: [] }));
        await flushAsyncWork();

        expect(host.querySelector('.tfvc-code-review-online__file-change')).toBeNull();
    });

    it('names a change that the counts do not describe', async () => {
        renderReview(host, model({
            threads: [],
            files: [reviewedFile({ changeType: 'add' })],
        }));
        await flushAsyncWork();

        expect(host.querySelector('.tfvc-code-review-online__file-change')?.textContent).toBe('add');
    });

    it('crosses out a file the review deletes', async () => {
        renderReview(host, model({
            threads: [],
            files: [
                reviewedFile({ path: '$/ExampleProject/src/Gone.cs', changeType: 'delete' }),
                reviewedFile({ path: '$/ExampleProject/src/Stays.cs' }),
            ],
        }));
        await flushAsyncWork();

        const nameOf = (file: string): string => Array.from(
            host.querySelectorAll('.tfvc-code-review-online__tree-name'))
            .filter((node) => node.textContent === file)[0].className;

        expect(nameOf('Gone.cs')).toContain('tree-name--deleted');
        expect(nameOf('Stays.cs')).not.toContain('tree-name--deleted');
    });

    it('offers each tree row its own menu, and folders none', async () => {
        // The tree shows the trailing segment of a path; this is where the whole of it can be had.
        // The copying itself is covered in clipboard.test.ts.
        renderReview(host, model({ threads: [] }));
        await flushAsyncWork();

        const actions = Array.from(host.querySelectorAll<HTMLButtonElement>(
            '.tfvc-code-review-online__tree-actions'));
        expect(actions).toHaveLength(1);

        actions[0].click();

        expect(menuLabels()).toEqual(['Copy full path']);
    });

    it('filters the tree as text is typed into the search box', async () => {
        renderReview(host, model({
            threads: [],
            files: [
                reviewedFile({ path: '$/ExampleProject/src/Alpha.cs' }),
                reviewedFile({ path: '$/ExampleProject/src/Zeta.cs' }),
            ],
        }));
        await flushAsyncWork();

        const search = host.querySelector('.tfvc-code-review-online__tree-search') as HTMLInputElement;
        search.value = 'zeta';
        search.dispatchEvent(new Event('input', { bubbles: true }));

        expect(treeNames()).toContain('Zeta.cs');
        expect(treeNames()).not.toContain('Alpha.cs');
    });

    it('says so when the search matches nothing', async () => {
        renderReview(host, model({ threads: [] }));
        await flushAsyncWork();

        const search = host.querySelector('.tfvc-code-review-online__tree-search') as HTMLInputElement;
        search.value = 'no-such-file';
        search.dispatchEvent(new Event('input', { bubbles: true }));

        const tree = host.querySelector('.tfvc-code-review-online__tree') as HTMLElement;
        expect(tree.textContent).toContain('No matching files.');
    });
});

describe('resolveTargetUrl', () => {
    it('addresses a shelveset by name and owner GUID', () => {
        // The route accepts the owner as an identity GUID, which is the form the work item stores --
        // so nothing has to be resolved before the link can be built. Verified against a collection.
        expect(resolveTargetUrl('https://tfs.example.com/DefaultCollection', 'Example Project', {
            kind: 'shelveset',
            shelvesetName: 'Sample',
            shelvesetId: 'Sample;00000000-0000-4000-8000-000000000001',
        })).toBe('https://tfs.example.com/DefaultCollection/Example%20Project/_versionControl'
            + '/shelveset?ss=Sample%3B00000000-0000-4000-8000-000000000001');
    });

    it('addresses a changeset by number', () => {
        expect(resolveTargetUrl('https://tfs.example.com/DefaultCollection/', 'Example', {
            kind: 'changeset',
            changesetId: 23113,
        })).toBe('https://tfs.example.com/DefaultCollection/Example/_versionControl/changeset/23113');
    });

    it('builds nothing without somewhere to point', () => {
        const target = { kind: 'shelveset' as const, shelvesetName: 'S', shelvesetId: 'S;g' };

        expect(resolveTargetUrl('', 'Example', target)).toBeUndefined();
        expect(resolveTargetUrl('https://tfs.example.com/C', '', target)).toBeUndefined();
        expect(resolveTargetUrl('https://tfs.example.com/C', 'Example', {
            kind: 'unknown',
            reason: 'No shelveset name.',
        })).toBeUndefined();
    });

    it('marks the heading link as leaving the page', () => {
        // A link that moves you out of the page without saying so first is a small betrayal of the
        // click, so it carries an icon and says "new tab" in its tooltip.
        renderReview(host, model({
            collectionUri: 'https://tfs.example.com/DefaultCollection',
            projectName: 'Example',
        }));

        const link = host.querySelector(
            'a.tfvc-code-review-online__review-heading-name') as HTMLAnchorElement;
        expect(link.target).toBe('_blank');
        expect(link.rel).toBe('noopener noreferrer');
        expect(link.title).toContain('new tab');
        expect(link.querySelector('.tfvc-code-review-online__external-icon')).not.toBeNull();
    });
});
