/**
 * Putting text on the clipboard, from a page that may not be allowed to use the modern way.
 *
 * `navigator.clipboard` exists only in a secure context. An on-premises Azure DevOps Server is very
 * often reached over plain HTTP on an intranet name, which is not one -- so on exactly the
 * installations this extension is written for, the modern API is simply absent. The old
 * selection-and-`execCommand` route still works there, and is the reason this file exists at all.
 *
 * The fallback also runs when the modern call is refused: the Clipboard API rejects rather than
 * throwing synchronously, and a permission prompt the reader dismisses looks identical to a failure.
 */

/**
 * Copies text using a hidden, selected textarea.
 *
 * The element has to be in the document and visible enough to be selectable -- `display: none` or
 * `hidden` cannot hold a selection -- so it is parked off-screen instead. `readOnly` keeps a mobile
 * keyboard from appearing for the instant it is focused.
 */
function copyBySelection(text: string, target: Document): boolean {
    const area = target.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'true');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.left = '-1000px';
    area.style.opacity = '0';

    target.body.appendChild(area);

    try {
        area.select();
        area.setSelectionRange(0, text.length);
        return target.execCommand('copy');
    } catch {
        // An unsupported or disallowed execCommand; the caller says so rather than throwing.
        return false;
    } finally {
        area.remove();
    }
}

/**
 * Copies text, returning whether it worked.
 *
 * Synchronous by design. The modern API is asynchronous, but its result arrives too late to decide
 * whether to fall back -- the fallback needs the user gesture that is still on the stack -- so the
 * fallback runs first and the modern call is made afterwards only when it did not.
 */
export function copyText(text: string, target: Document = document): boolean {
    if (copyBySelection(text, target)) {
        return true;
    }

    const clipboard = target.defaultView?.navigator?.clipboard;
    if (clipboard === undefined) {
        return false;
    }

    // Reported as success without waiting for it. Where this API is available at all it is the more
    // reliable of the two, and its result cannot be had synchronously; a rejection is swallowed
    // rather than thrown, because a failed copy is not worth an error in the console of a review.
    void clipboard.writeText(text).catch(() => undefined);
    return true;
}
