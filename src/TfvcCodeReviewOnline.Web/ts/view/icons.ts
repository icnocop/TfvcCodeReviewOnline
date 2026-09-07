/**
 * The icons this tab draws.
 *
 * Inline SVG rather than a font glyph or an image: they inherit `currentColor`, so they follow
 * whichever theme the host has applied, and they need no asset in the package. Every icon is marked
 * `aria-hidden` -- each one sits next to, or inside a control that carries, its own text, so
 * announcing the icon as well would only repeat it.
 */

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function svgElement<TElement extends SVGElement>(tagName: string): TElement {
    return document.createElementNS(SVG_NAMESPACE, tagName) as TElement;
}

function iconRoot(cssClass?: string): SVGSVGElement {
    const svg = svgElement<SVGSVGElement>('svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (cssClass !== undefined) {
        // setAttribute, not .className: on an SVG element that property is a read-only
        // SVGAnimatedString rather than a plain string.
        svg.setAttribute('class', cssClass);
    }
    return svg;
}

function outlinePath(definition: string, filled = false): SVGPathElement {
    const path = svgElement<SVGPathElement>('path');
    path.setAttribute('d', definition);
    path.setAttribute('fill', filled ? 'currentColor' : 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.1');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');
    return path;
}

/**
 * A folder, in the manila colour every file explorer uses for one.
 *
 * Filled rather than outlined, and the one icon in this file that does not follow `currentColor`: a
 * folder is recognized by its colour before its shape, and a grey outline among grey text is easy to
 * read straight past. Deliberately one icon rather than open and closed variants -- the chevron
 * beside it already says whether the folder is expanded.
 */
export function folderIcon(cssClass?: string): SVGElement {
    const svg = iconRoot(cssClass);

    const folder = outlinePath('M1.5 12.5v-9h4l1.5 2h7.5v7z', true);
    folder.setAttribute('fill', '#dcb67a');
    folder.setAttribute('stroke', '#c19a5b');
    svg.appendChild(folder);

    return svg;
}

/**
 * A box with an arrow leaving it: this link opens somewhere else.
 *
 * Worth the pixels because the link goes to another tab, and a link that moves you out of the page
 * without saying so first is a small betrayal of the click.
 */
export function externalLinkIcon(cssClass?: string): SVGElement {
    const svg = iconRoot(cssClass);
    svg.setAttribute('width', '11');
    svg.setAttribute('height', '11');
    // Three sides of a box, left open where the arrow leaves it.
    svg.appendChild(outlinePath('M9 2.5H2.5v11h11V7'));
    // The arrow itself, and its head.
    svg.appendChild(outlinePath('M7 9 14 2'));
    svg.appendChild(outlinePath('M9.5 1.5H14.5V6.5'));
    return svg;
}

/** A pane with a divided-off column, for the control that shows and hides the navigation tree. */
export function panelIcon(cssClass?: string): SVGElement {
    const svg = iconRoot(cssClass);
    svg.appendChild(outlinePath('M1.5 2.5h13v11h-13z'));
    svg.appendChild(outlinePath('M6 2.5v11'));
    return svg;
}

/** A document with a folded corner. */
export function fileIcon(cssClass?: string): SVGElement {
    const svg = iconRoot(cssClass);
    svg.appendChild(outlinePath('M3.5 1.5h6l3 3v10h-9z'));
    // The fold itself, so the shape does not read as a plain rectangle.
    svg.appendChild(outlinePath('M9.5 1.5v3h3'));
    return svg;
}

/**
 * A speech bubble with a plus in it: "start a comment here".
 *
 * Matches the affordance Visual Studio uses for the same action, so the meaning carries over for
 * anyone who has used code review there.
 */
export function commentPlusIcon(): SVGElement {
    const svg = iconRoot();

    // Rounded rectangle with a tail at the bottom left, drawn as one outline.
    svg.appendChild(outlinePath('M1.5 2.5h13v8h-8l-3.5 3v-3h-1.5z'));

    for (const definition of [
        // The two strokes of the plus, centred in the bubble.
        { x1: '8', y1: '4', x2: '8', y2: '9' },
        { x1: '5.5', y1: '6.5', x2: '10.5', y2: '6.5' },
    ]) {
        const stroke = svgElement<SVGLineElement>('line');
        stroke.setAttribute('x1', definition.x1);
        stroke.setAttribute('y1', definition.y1);
        stroke.setAttribute('x2', definition.x2);
        stroke.setAttribute('y2', definition.y2);
        stroke.setAttribute('stroke', 'currentColor');
        stroke.setAttribute('stroke-width', '1.2');
        stroke.setAttribute('stroke-linecap', 'round');
        svg.appendChild(stroke);
    }

    return svg;
}

/**
 * Three dots: "there is more you can do with this".
 *
 * The conventional overflow affordance, and the one the built-in file tree uses in the same place.
 */
export function ellipsisIcon(cssClass?: string): SVGElement {
    const svg = iconRoot(cssClass);

    for (const x of [3.5, 8, 12.5]) {
        const dot = svgElement<SVGCircleElement>('circle');
        dot.setAttribute('cx', String(x));
        dot.setAttribute('cy', '8');
        dot.setAttribute('r', '1.3');
        dot.setAttribute('fill', 'currentColor');
        svg.appendChild(dot);
    }

    return svg;
}

/** An arrow, pointing the way the control moves through the review. */
export function arrowIcon(direction: 'up' | 'down', cssClass?: string): SVGElement {
    const svg = iconRoot(cssClass);
    svg.appendChild(outlinePath('M8 2.5v11'));
    svg.appendChild(outlinePath(direction === 'up' ? 'M3.5 7 8 2.5 12.5 7' : 'M3.5 9 8 13.5 12.5 9'));
    return svg;
}

/** A gear: the settings for the thing it sits beside. */
export function gearIcon(cssClass?: string): SVGElement {
    const svg = iconRoot(cssClass);

    // The toothed ring, drawn as a circle with eight short spokes crossing its edge.
    const hub = svgElement<SVGCircleElement>('circle');
    hub.setAttribute('cx', '8');
    hub.setAttribute('cy', '8');
    hub.setAttribute('r', '2.6');
    hub.setAttribute('fill', 'none');
    hub.setAttribute('stroke', 'currentColor');
    hub.setAttribute('stroke-width', '1.1');
    svg.appendChild(hub);

    const ring = svgElement<SVGCircleElement>('circle');
    ring.setAttribute('cx', '8');
    ring.setAttribute('cy', '8');
    ring.setAttribute('r', '5.4');
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', 'currentColor');
    ring.setAttribute('stroke-width', '1.1');
    // Dashes around the circumference read as teeth without eight separate paths to keep in step.
    ring.setAttribute('stroke-dasharray', '2.1 2.1');
    svg.appendChild(ring);

    return svg;
}
