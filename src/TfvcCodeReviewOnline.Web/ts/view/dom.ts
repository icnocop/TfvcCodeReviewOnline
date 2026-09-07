/**
 * The small set of DOM helpers every view is built from.
 *
 * Two rules are enforced here rather than repeated in each view:
 *
 *   * text is always written with `textContent`, never `innerHTML`. Review comments, file paths, and
 *     display names are user-supplied, and a viewer that rendered them as markup would be an
 *     injection vector on every review it displayed.
 *   * every element is classed under one root, because the stylesheet scopes every rule under that
 *     class so the extension cannot restyle the host's own chrome.
 */

export const ROOT_CLASS = 'tfvc-code-review-online';

/** Builds a class name in the block's namespace, for example `tfvc-code-review-online__title`. */
export function className(suffix: string): string {
    return `${ROOT_CLASS}__${suffix}`;
}

/**
 * Builds a modifier on the block itself, for example `tfvc-code-review-online--dragging`.
 *
 * Distinct from `className`, which names an element *within* the block. A state that applies to the
 * whole tab belongs on the root, and writing it with the element separator would name a child that
 * does not exist.
 */
export function rootModifier(suffix: string): string {
    return `${ROOT_CLASS}--${suffix}`;
}

export function element<TTagName extends keyof HTMLElementTagNameMap>(
    tagName: TTagName,
    cssClass?: string,
    text?: string): HTMLElementTagNameMap[TTagName] {
    const created = document.createElement(tagName);
    if (cssClass) {
        created.className = cssClass;
    }
    if (text !== undefined) {
        created.textContent = text;
    }
    return created;
}

/** Replaces a host's content with a fresh, correctly classed root element. */
export function resetRoot(host: HTMLElement): HTMLElement {
    host.textContent = '';
    const root = element('div', ROOT_CLASS);
    host.appendChild(root);
    return root;
}

export function section(title?: string): HTMLElement {
    const container = element('section', className('section'));
    if (title !== undefined) {
        container.appendChild(element('h2', className('heading'), title));
    }
    return container;
}

export function definitionList(entries: readonly (readonly [string, string])[]): HTMLElement {
    const list = element('dl', className('facts'));
    for (const [term, value] of entries) {
        list.appendChild(element('dt', undefined, term));
        list.appendChild(element('dd', undefined, value));
    }
    return list;
}

/**
 * Formats a timestamp for display, falling back to the raw value.
 *
 * Deliberately locale-formatted rather than fixed: the reader's own conventions are the ones that
 * make a date legible at a glance, and the exact instant is preserved in the tooltip anyway.
 */
export function formatTimestamp(value: string | undefined): string {
    if (!value) {
        return '';
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
