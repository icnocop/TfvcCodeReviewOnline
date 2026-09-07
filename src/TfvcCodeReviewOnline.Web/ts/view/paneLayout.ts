/**
 * The divider between the navigation tree and the review, and the control that hides the tree
 * altogether.
 *
 * The width is tracked here as a number rather than read back from the element on each drag. Reading
 * layout mid-drag is both slower and less predictable -- a pane that has been collapsed, or is being
 * measured while the browser is still settling, reports a width that has nothing to do with where the
 * reader put the divider. Keeping the number means the drag arithmetic is exact, and it is what gets
 * remembered.
 */

import { className, element, rootModifier } from './dom';
import { panelIcon } from './icons';

/** Narrow enough to be worth having, wide enough that a path is still readable. */
export const MINIMUM_TREE_WIDTH = 150;

/** Past this the tree is taking space from the thing it exists to navigate. */
export const MAXIMUM_TREE_WIDTH = 700;

export const DEFAULT_TREE_WIDTH = 260;

/** How far one arrow-key press moves the divider. */
const KEYBOARD_STEP = 16;

/**
 * Drag the divider narrower than this and the pane closes instead of stopping at its minimum.
 *
 * Below the minimum width the tree shows nothing useful anyway, so refusing to go further just leaves
 * the reader pushing against a wall. Closing it is what they were plainly trying to do.
 */
const COLLAPSE_AT_WIDTH = 90;

/** Neither side of a side-by-side diff may be squeezed past this share of the space. */
export const MINIMUM_COLUMN_RATIO = 0.2;
export const MAXIMUM_COLUMN_RATIO = 0.8;
export const DEFAULT_COLUMN_RATIO = 0.5;

/**
 * The left column's new share after the divider between two code columns is dragged.
 *
 * Kept as a pure function of the ratio, the movement, and the space available, because that is the
 * part worth testing: the rest is measuring the DOM, which no unit test can meaningfully assert.
 */
export function nextColumnRatio(
    current: number,
    deltaPixels: number,
    availableWidth: number): number {
    if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
        return current;
    }
    const proposed = current + deltaPixels / availableWidth;
    if (!Number.isFinite(proposed)) {
        return current;
    }
    return Math.min(MAXIMUM_COLUMN_RATIO, Math.max(MINIMUM_COLUMN_RATIO, proposed));
}

export interface PaneLayout {
    readonly width: number;
    readonly collapsed: boolean;
}

/** A remembered layout, where either part may be absent because it was never set. */
export interface RememberedPaneLayout {
    readonly width?: number;
    readonly collapsed?: boolean;
}

export interface PaneLayoutOptions {
    /** The pane being sized -- the tree. */
    readonly pane: HTMLElement;
    /** Root element, which carries the class that suppresses selection while dragging. */
    readonly root: HTMLElement;
    readonly initial: PaneLayout;
    /** Called when the reader finishes a drag, or opens or closes the drawer. */
    readonly onChanged: (layout: PaneLayout) => void;
}

export interface PaneLayoutControls {
    readonly splitter: HTMLElement;
    /** Closes the pane. Belongs in the pane's own header, where its meaning is unambiguous. */
    readonly collapseButton: HTMLButtonElement;
    /**
     * Reopens it. Shown only while the pane is closed, in its place, so the way back is where the
     * pane used to be rather than hidden among the controls at the top of the tab.
     */
    readonly expandButton: HTMLButtonElement;
}

export function clampTreeWidth(width: number): number {
    if (!Number.isFinite(width)) {
        return DEFAULT_TREE_WIDTH;
    }
    return Math.min(MAXIMUM_TREE_WIDTH, Math.max(MINIMUM_TREE_WIDTH, Math.round(width)));
}

export function createPaneLayout(options: PaneLayoutOptions): PaneLayoutControls {
    let width = clampTreeWidth(options.initial.width);
    let collapsed = options.initial.collapsed;

    const splitter = element('div', className('splitter'));
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', 'vertical');
    splitter.setAttribute('aria-label', 'Resize the file tree');
    splitter.setAttribute('aria-valuemin', String(MINIMUM_TREE_WIDTH));
    splitter.setAttribute('aria-valuemax', String(MAXIMUM_TREE_WIDTH));
    splitter.tabIndex = 0;

    const collapseButton = element('button', className('icon-button'), '\u27e8');
    collapseButton.type = 'button';
    collapseButton.title = 'Hide the file tree';
    collapseButton.setAttribute('aria-label', 'Hide the file tree');

    const expandButton = element('button', className('pane-rail'));
    expandButton.type = 'button';
    expandButton.title = 'Show the file tree';
    expandButton.setAttribute('aria-label', 'Show the file tree');
    expandButton.appendChild(panelIcon());

    const applyWidth = (): void => {
        // flex-basis rather than width: the pane is a flex item, and setting width would leave the
        // flex basis in charge and the two disagreeing.
        options.pane.style.flexBasis = `${width}px`;
        splitter.setAttribute('aria-valuenow', String(width));
    };

    const applyCollapsed = (): void => {
        options.pane.hidden = collapsed;
        splitter.hidden = collapsed;
        // Exactly one of the two is ever visible, so there is never a question of which to press.
        expandButton.hidden = !collapsed;
        collapseButton.setAttribute('aria-expanded', String(!collapsed));
    };

    const report = (): void => { options.onChanged({ width, collapsed }); };

    const setWidth = (next: number): void => {
        const clamped = clampTreeWidth(next);
        if (clamped === width) {
            return;
        }
        width = clamped;
        applyWidth();
    };

    // --- dragging ---------------------------------------------------------------------------------

    let dragStartX = 0;
    let dragStartWidth = 0;

    const onPointerMove = (event: MouseEvent): void => {
        const proposed = dragStartWidth + (event.clientX - dragStartX);

        // Dragged past the point of usefulness: close it rather than stopping at the minimum.
        if (proposed < COLLAPSE_AT_WIDTH) {
            if (!collapsed) {
                collapsed = true;
                applyCollapsed();
            }
            return;
        }

        // Dragging back out reopens it, so the gesture is reversible without reaching for the toggle.
        if (collapsed) {
            collapsed = false;
            applyCollapsed();
        }
        setWidth(proposed);
    };

    const onPointerUp = (): void => {
        const owner = splitter.ownerDocument;
        owner.removeEventListener('mousemove', onPointerMove);
        owner.removeEventListener('mouseup', onPointerUp);
        options.root.classList.remove(rootModifier('dragging'));
        report();
    };

    splitter.addEventListener('mousedown', (event) => {
        // Without this the drag selects the code it passes over, which then fights the
        // selection-to-comment behavior in the diff.
        event.preventDefault();

        dragStartX = event.clientX;
        dragStartWidth = width;

        const owner = splitter.ownerDocument;
        owner.addEventListener('mousemove', onPointerMove);
        owner.addEventListener('mouseup', onPointerUp);
        options.root.classList.add(rootModifier('dragging'));
    });

    // Dragging is not the only way to move a separator, and a keyboard user has no other.
    splitter.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowLeft' ? -KEYBOARD_STEP
            : event.key === 'ArrowRight' ? KEYBOARD_STEP
                : 0;

        if (step !== 0) {
            event.preventDefault();
            setWidth(width + step);
            report();
            return;
        }

        if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            setWidth(event.key === 'Home' ? MINIMUM_TREE_WIDTH : MAXIMUM_TREE_WIDTH);
            report();
        }
    });

    // --- the drawer -------------------------------------------------------------------------------

    const setCollapsed = (next: boolean): void => {
        collapsed = next;
        applyCollapsed();
        report();
    };

    collapseButton.addEventListener('click', () => { setCollapsed(true); });
    expandButton.addEventListener('click', () => { setCollapsed(false); });

    applyWidth();
    applyCollapsed();

    return { splitter, collapseButton, expandButton };
}

export interface ColumnSplitterOptions {
    /** Positioned container the handle is placed over -- the diff host. */
    readonly host: HTMLElement;
    /** A cell of the left code column, used to find where the boundary currently sits. */
    readonly measureFrom: () => HTMLElement | undefined;
    /** Root element, which carries the class that suppresses selection while dragging. */
    readonly root: HTMLElement;
    readonly initialRatio: number;
    /** Sets the left column's share. The caller owns how that is expressed in the table. */
    readonly applyRatio: (ratio: number) => void;
    readonly onRatioChanged: (ratio: number) => void;
}

/** How much one arrow-key press moves the boundary between two code columns. */
const COLUMN_KEYBOARD_STEP = 0.02;

/** Half the splitter's width, so the line inside it lands on the boundary rather than beside it. */
const COLUMN_SPLITTER_OFFSET = 5;

/**
 * A draggable boundary between the two code columns of a side-by-side diff.
 *
 * The handle floats over the table rather than living in it. A table column cannot itself be a drag
 * target -- there is no element spanning a column -- and adding a header row to hold one would put a
 * strip of chrome above every diff for the sake of a control that is only occasionally wanted.
 */
export function createColumnSplitter(options: ColumnSplitterOptions): HTMLElement {
    let ratio = options.initialRatio;

    const handle = element('div', className('column-splitter'));
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', 'Resize the compared versions');
    handle.tabIndex = 0;

    /** Moves the handle to wherever the boundary has ended up after a layout change. */
    const reposition = (): void => {
        const cell = options.measureFrom();
        if (cell === undefined || typeof cell.getBoundingClientRect !== 'function') {
            return;
        }
        const cellRect = cell.getBoundingClientRect();
        const hostRect = options.host.getBoundingClientRect();
        if (cellRect.width === 0) {
            // Not laid out yet, or hidden. Leaving the handle where it is beats moving it to zero.
            return;
        }

        // `scrollLeft` matters. The rectangles are in viewport coordinates, but the handle is
        // positioned against the host's padding box, which scrolls with the content -- so without
        // this the divider drifts by exactly however far the diff has been scrolled sideways, which
        // only ever happens when wrapping is off.
        handle.style.left = `${
            cellRect.right - hostRect.left + options.host.scrollLeft - COLUMN_SPLITTER_OFFSET}px`;
    };

    const setRatio = (next: number): void => {
        if (next === ratio) {
            return;
        }
        ratio = next;
        options.applyRatio(ratio);
        handle.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
        reposition();
    };

    let dragStartX = 0;
    let dragStartRatio = 0;
    let dragWidth = 0;

    const onPointerMove = (event: MouseEvent): void => {
        setRatio(nextColumnRatio(dragStartRatio, event.clientX - dragStartX, dragWidth));
    };

    const onPointerUp = (): void => {
        const owner = handle.ownerDocument;
        owner.removeEventListener('mousemove', onPointerMove);
        owner.removeEventListener('mouseup', onPointerUp);
        options.root.classList.remove(rootModifier('dragging'));
        options.onRatioChanged(ratio);
    };

    handle.addEventListener('mousedown', (event) => {
        event.preventDefault();
        dragStartX = event.clientX;
        dragStartRatio = ratio;

        // The space the two code columns share, measured once so the drag arithmetic is stable even
        // as the columns move underneath it.
        const cell = options.measureFrom();
        const cellWidth = cell?.getBoundingClientRect().width ?? 0;
        dragWidth = ratio > 0 ? cellWidth / ratio : 0;

        const owner = handle.ownerDocument;
        owner.addEventListener('mousemove', onPointerMove);
        owner.addEventListener('mouseup', onPointerUp);
        options.root.classList.add(rootModifier('dragging'));
    });

    handle.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowLeft' ? -COLUMN_KEYBOARD_STEP
            : event.key === 'ArrowRight' ? COLUMN_KEYBOARD_STEP
                : 0;
        if (step === 0) {
            return;
        }
        event.preventDefault();
        setRatio(Math.min(MAXIMUM_COLUMN_RATIO, Math.max(MINIMUM_COLUMN_RATIO, ratio + step)));
        options.onRatioChanged(ratio);
    });

    handle.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));

    // The boundary moves when the diff is scrolled sideways or the frame is resized, and the handle
    // has to follow it rather than being placed once and left behind.
    options.host.addEventListener('scroll', reposition);
    window.addEventListener('resize', reposition);

    // Deferred so the table has been laid out by the time the boundary is first measured.
    window.setTimeout(reposition, 0);

    return handle;
}
