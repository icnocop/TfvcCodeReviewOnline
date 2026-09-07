/**
 * A small popup menu, anchored to the control that opened it.
 *
 * Positioned `fixed` against the anchor's rectangle rather than nested inside it. The alternative --
 * an absolutely positioned child -- gets clipped by the first ancestor that scrolls, and in this tab
 * every control worth attaching a menu to sits inside one. The cost is that the menu does not travel
 * with the page, so it closes on scroll rather than drifting away from the button that opened it.
 */

import { className, element } from './dom';

export interface MenuItem {
    readonly label: string;
    /**
     * Whether the option is currently in force, shown as a check.
     *
     * Absent means the item is an action rather than a setting -- "Copy full path" is done, not
     * turned on -- and it is then announced as a plain menu item with no checked state to report.
     */
    readonly checked?: boolean;
    readonly onChoose: () => void;
}

/** Items are drawn in groups, separated by a rule. */
export interface MenuGroup {
    readonly items: readonly MenuItem[];
}

/** Space between the anchor and the menu, so the two do not touch. */
const ANCHOR_GAP = 2;

/** A check mark, or the space one would occupy, so labels line up whether ticked or not. */
function checkMark(checked: boolean): HTMLElement {
    return element('span', className('menu-check'), checked ? '\u2713' : '');
}

/**
 * Opens a menu and returns a function that closes it.
 *
 * Only one menu is open at a time: opening a second closes the first, which is what a reader expects
 * and also saves every caller from tracking one.
 */
let closeOpenMenu: (() => void) | undefined;

export function openMenu(anchor: HTMLElement, groups: readonly MenuGroup[]): () => void {
    closeOpenMenu?.();

    const menu = element('div', className('menu'));
    menu.setAttribute('role', 'menu');

    const close = (): void => {
        menu.remove();
        anchor.ownerDocument.removeEventListener('mousedown', onDocumentPointerDown, true);
        anchor.ownerDocument.removeEventListener('keydown', onKeyDown, true);
        anchor.ownerDocument.removeEventListener('scroll', close, true);
        anchor.setAttribute('aria-expanded', 'false');
        if (closeOpenMenu === close) {
            closeOpenMenu = undefined;
        }
    };

    function onDocumentPointerDown(event: MouseEvent): void {
        const target = event.target;
        // A click on the anchor is the anchor's own business: it toggles, and closing here as well
        // would close and reopen in one gesture.
        if (target instanceof Node && (menu.contains(target) || anchor.contains(target))) {
            return;
        }
        close();
    }

    function onKeyDown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
            anchor.focus();
        }
    }

    groups.forEach((group, index) => {
        if (index > 0) {
            menu.appendChild(element('div', className('menu-separator')));
        }

        for (const item of group.items) {
            const button = element('button', className('menu-item'));
            button.type = 'button';
            if (item.checked === undefined) {
                button.setAttribute('role', 'menuitem');
            } else {
                button.setAttribute('role', 'menuitemcheckbox');
                button.setAttribute('aria-checked', String(item.checked));
            }

            button.appendChild(checkMark(item.checked === true));
            button.appendChild(element('span', className('menu-label'), item.label));

            button.addEventListener('click', () => {
                close();
                item.onChoose();
            });

            menu.appendChild(button);
        }
    });

    anchor.ownerDocument.body.appendChild(menu);

    // Measured after it is in the document, because until then it has no size to place.
    const anchorRect = anchor.getBoundingClientRect();
    const view = anchor.ownerDocument.defaultView;
    const menuRect = menu.getBoundingClientRect();

    const viewportWidth = view?.innerWidth ?? 0;
    const viewportHeight = view?.innerHeight ?? 0;

    // Below the anchor and aligned to its right edge, flipping above or inward where there is no
    // room -- a menu that opens off-screen is a menu that cannot be used.
    const left = viewportWidth > 0
        ? Math.max(4, Math.min(anchorRect.right - menuRect.width, viewportWidth - menuRect.width - 4))
        : anchorRect.left;
    const below = anchorRect.bottom + ANCHOR_GAP;
    const top = viewportHeight > 0 && below + menuRect.height > viewportHeight
        ? Math.max(4, anchorRect.top - menuRect.height - ANCHOR_GAP)
        : below;

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;

    anchor.setAttribute('aria-expanded', 'true');
    anchor.ownerDocument.addEventListener('mousedown', onDocumentPointerDown, true);
    anchor.ownerDocument.addEventListener('keydown', onKeyDown, true);
    // Capturing, so it also catches the panes scrolling rather than only the document.
    anchor.ownerDocument.addEventListener('scroll', close, true);

    closeOpenMenu = close;
    return close;
}

/** True when a menu is currently open. Lets an anchor toggle rather than reopen. */
export function isMenuOpen(): boolean {
    return closeOpenMenu !== undefined;
}

/** Closes whatever menu is open, if any. */
export function closeMenu(): void {
    closeOpenMenu?.();
}
