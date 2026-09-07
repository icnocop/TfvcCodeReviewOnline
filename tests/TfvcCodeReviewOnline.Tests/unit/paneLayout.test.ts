import { beforeEach, describe, expect, it } from 'vitest';

import {
    clampTreeWidth,
    createPaneLayout,
    DEFAULT_TREE_WIDTH,
    MAXIMUM_COLUMN_RATIO,
    MAXIMUM_TREE_WIDTH,
    MINIMUM_COLUMN_RATIO,
    MINIMUM_TREE_WIDTH,
    nextColumnRatio,
    type PaneLayout,
} from '../../../src/TfvcCodeReviewOnline.Web/ts/view/paneLayout';

let root: HTMLElement;
let pane: HTMLElement;
let reported: PaneLayout[];

beforeEach(() => {
    document.body.textContent = '';
    root = document.createElement('div');
    root.className = 'tfvc-code-review-online';
    pane = document.createElement('nav');
    root.appendChild(pane);
    document.body.appendChild(root);
    reported = [];
});

function build(initial: Partial<PaneLayout> = {}): ReturnType<typeof createPaneLayout> {
    const controls = createPaneLayout({
        pane,
        root,
        initial: {
            width: initial.width ?? DEFAULT_TREE_WIDTH,
            collapsed: initial.collapsed ?? false,
        },
        onChanged: (layout) => { reported.push(layout); },
    });
    root.appendChild(controls.splitter);
    return controls;
}

/** Presses the mouse on the splitter, moves it, and releases -- one complete drag. */
function drag(splitter: HTMLElement, fromX: number, toX: number): void {
    splitter.dispatchEvent(new MouseEvent('mousedown', { clientX: fromX, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: toX, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

describe('clampTreeWidth', () => {
    it('keeps a width within the usable range', () => {
        expect(clampTreeWidth(300)).toBe(300);
        expect(clampTreeWidth(10)).toBe(MINIMUM_TREE_WIDTH);
        expect(clampTreeWidth(5000)).toBe(MAXIMUM_TREE_WIDTH);
    });

    it('falls back to the default for a value that is not a number', () => {
        // A stored preference can be anything if it was written by an older version or edited.
        expect(clampTreeWidth(Number.NaN)).toBe(DEFAULT_TREE_WIDTH);
    });
});

describe('createPaneLayout', () => {
    it('applies the remembered width to the pane', () => {
        build({ width: 320 });

        expect(pane.style.flexBasis).toBe('320px');
    });

    it('starts closed when that is how it was left', () => {
        const { splitter } = build({ collapsed: true });

        expect(pane.hidden).toBe(true);
        expect(splitter.hidden).toBe(true);
    });

    it('widens the pane as the divider is dragged right', () => {
        const { splitter } = build({ width: 260 });

        drag(splitter, 300, 360);

        expect(pane.style.flexBasis).toBe('320px');
    });

    it('narrows the pane as the divider is dragged left', () => {
        const { splitter } = build({ width: 260 });

        drag(splitter, 300, 240);

        expect(pane.style.flexBasis).toBe('200px');
    });

    it('refuses to drag the pane wider than is useful', () => {
        const { splitter } = build({ width: 260 });

        drag(splitter, 300, 9000);

        expect(pane.style.flexBasis).toBe(`${MAXIMUM_TREE_WIDTH}px`);
    });

    it('stops at the minimum width before closing', () => {
        const { splitter } = build({ width: 260 });

        // 300 -> 190 is a 110px reduction, landing at 150 -- narrow, but not yet past the point of
        // being worth showing.
        drag(splitter, 300, 190);

        expect(pane.style.flexBasis).toBe(`${MINIMUM_TREE_WIDTH}px`);
        expect(pane.hidden).toBe(false);
    });

    it('closes the pane when dragged past the point of usefulness', () => {
        // Below the minimum the tree shows nothing worth reading, so refusing to go further just
        // leaves the reader pushing against a wall when they plainly meant to close it.
        const { splitter } = build({ width: 260 });

        drag(splitter, 300, 100);

        expect(pane.hidden).toBe(true);
        expect(reported[reported.length - 1].collapsed).toBe(true);
    });

    it('reopens the pane when dragged back out, without leaving the drag', () => {
        const { splitter } = build({ width: 260 });

        splitter.dispatchEvent(new MouseEvent('mousedown', { clientX: 300, bubbles: true }));
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, bubbles: true }));
        expect(pane.hidden).toBe(true);

        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 340, bubbles: true }));
        expect(pane.hidden).toBe(false);
        expect(pane.style.flexBasis).toBe('300px');

        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        expect(reported).toEqual([{ width: 300, collapsed: false }]);
    });

    it('remembers the width it had when it was dragged closed', () => {
        // So reopening restores the pane the reader had set up, not a default.
        const { splitter, expandButton } = build({ width: 320 });

        // 320 - 250 = 70, which is past the point where the pane closes rather than narrowing.
        drag(splitter, 300, 50);
        expect(pane.hidden).toBe(true);

        expandButton.click();

        expect(pane.hidden).toBe(false);
        expect(pane.style.flexBasis).toBe('320px');
    });

    it('reports the new width once the drag is finished, not on every movement', () => {
        // The preference is written to the server; doing that on every mousemove would be a request
        // per pixel.
        const { splitter } = build({ width: 260 });

        splitter.dispatchEvent(new MouseEvent('mousedown', { clientX: 300, bubbles: true }));
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 310, bubbles: true }));
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 320, bubbles: true }));
        expect(reported).toEqual([]);

        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        expect(reported).toEqual([{ width: 280, collapsed: false }]);
    });

    it('stops following the mouse once the drag ends', () => {
        const { splitter } = build({ width: 260 });

        drag(splitter, 300, 320);
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 900, bubbles: true }));

        expect(pane.style.flexBasis).toBe('280px');
    });

    it('suppresses selection while dragging, and restores it afterwards', () => {
        // Otherwise the drag selects the code it passes over, which then fights the
        // select-lines-to-comment behavior in the diff.
        const { splitter } = build();

        splitter.dispatchEvent(new MouseEvent('mousedown', { clientX: 300, bubbles: true }));
        expect(root.className).toContain('tfvc-code-review-online--dragging');

        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        expect(root.className).not.toContain('tfvc-code-review-online--dragging');
    });

    it('moves the divider with the arrow keys', () => {
        const { splitter } = build({ width: 260 });

        splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(pane.style.flexBasis).toBe('276px');

        splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        expect(pane.style.flexBasis).toBe('260px');
    });

    it('jumps to either end with Home and End', () => {
        const { splitter } = build({ width: 260 });

        splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        expect(pane.style.flexBasis).toBe(`${MAXIMUM_TREE_WIDTH}px`);

        splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        expect(pane.style.flexBasis).toBe(`${MINIMUM_TREE_WIDTH}px`);
    });

    it('describes itself as a separator, for anyone not using a mouse', () => {
        const { splitter } = build({ width: 260 });

        expect(splitter.getAttribute('role')).toBe('separator');
        expect(splitter.getAttribute('aria-valuenow')).toBe('260');
        expect(splitter.tabIndex).toBe(0);
    });

    it('closes and reopens the drawer, reporting each change', () => {
        // Exactly one of the two buttons is ever visible, so there is never a question of which to
        // press: the rail appears where the pane was, and the collapse control lives in its header.
        const { collapseButton, expandButton, splitter } = build();

        expect(expandButton.hidden).toBe(true);

        collapseButton.click();
        expect(pane.hidden).toBe(true);
        expect(splitter.hidden).toBe(true);
        expect(expandButton.hidden).toBe(false);
        expect(collapseButton.getAttribute('aria-expanded')).toBe('false');

        expandButton.click();
        expect(pane.hidden).toBe(false);
        expect(splitter.hidden).toBe(false);
        expect(expandButton.hidden).toBe(true);

        expect(reported.map((layout) => layout.collapsed)).toEqual([true, false]);
    });

    it('keeps the width it had while closed, so reopening restores it', () => {
        const { collapseButton, expandButton } = build({ width: 340 });

        collapseButton.click();
        expandButton.click();

        expect(pane.style.flexBasis).toBe('340px');
        expect(reported[1]).toEqual({ width: 340, collapsed: false });
    });
});

describe('nextColumnRatio', () => {
    it('shifts the boundary by the fraction of the space that was dragged', () => {
        expect(nextColumnRatio(0.5, 100, 1000)).toBeCloseTo(0.6);
        expect(nextColumnRatio(0.5, -100, 1000)).toBeCloseTo(0.4);
    });

    it('leaves both versions readable however far the drag goes', () => {
        expect(nextColumnRatio(0.5, -100000, 1000)).toBe(MINIMUM_COLUMN_RATIO);
        expect(nextColumnRatio(0.5, 100000, 1000)).toBe(MAXIMUM_COLUMN_RATIO);
    });

    it('stands still when there is no space to measure against', () => {
        // Which is what a hidden or not-yet-laid-out table reports, and moving the boundary on the
        // strength of a zero would send it to one extreme or the other.
        expect(nextColumnRatio(0.5, 100, 0)).toBe(0.5);
        expect(nextColumnRatio(0.5, 100, Number.NaN)).toBe(0.5);
    });
});
