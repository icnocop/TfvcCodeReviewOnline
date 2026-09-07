/**
 * The navigation tree down the left-hand side.
 *
 * Its job is to get the reader to a file quickly in a review that may span a hundred of them. It
 * therefore renders the whole tree at once -- no lazy expansion -- because a folder that has to be
 * opened before you can see whether the file you want is inside it is slower than scrolling.
 */

import { filterFileTree, type FileTreeNode } from '../model/fileTree';
import { copyText } from './clipboard';
import { className, element } from './dom';
import { ellipsisIcon, fileIcon, folderIcon } from './icons';
import { closeMenu, openMenu } from './menu';

const EXPANDED_GLYPH = '\u25be';
const COLLAPSED_GLYPH = '\u25b8';

/** Indentation per level. Kept modest because folder names here are long. */
const INDENT_PIXELS = 12;

export interface FileTreeViewOptions {
    readonly nodes: readonly FileTreeNode[];
    /** Called with the file's full server path when one is chosen. */
    readonly onSelect: (path: string) => void;
}

function renderBadge(threadCount: number): HTMLElement | undefined {
    if (threadCount === 0) {
        return undefined;
    }
    const badge = element('span', className('tree-badge'), String(threadCount));
    badge.title = threadCount === 1 ? '1 comment thread' : `${threadCount} comment threads`;
    return badge;
}

function renderRow(
    node: FileTreeNode,
    depth: number,
    glyph: string | undefined): HTMLButtonElement {
    const row = element('button', className('tree-row'));
    row.type = 'button';
    row.style.paddingLeft = `${4 + depth * INDENT_PIXELS}px`;

    // Present for a folder, and an empty placeholder for a file, so names stay aligned in a column.
    row.appendChild(element('span', className('tree-glyph'), glyph ?? ''));
    row.appendChild(node.kind === 'folder'
        ? folderIcon(`${className('tree-icon')} ${className('tree-icon--folder')}`)
        : fileIcon(`${className('tree-icon')} ${className('tree-icon--file')}`));
    // Struck through when the review deletes the file, as the built-in view draws it: it is the one
    // change that makes the name in the tree a name for something that will not be there.
    const name = element('span', className('tree-name'), node.name);
    if (node.deleted) {
        name.classList.add(className('tree-name--deleted'));
    }
    row.appendChild(name);

    const badge = renderBadge(node.threadCount);
    if (badge !== undefined) {
        row.appendChild(badge);
    }

    return row;
}

/**
 * The overflow menu for one file.
 *
 * The full path is the thing worth taking away from a tree: it is what a `tf` command, a search, or a
 * message to a colleague needs, and it is the one piece of a row that is deliberately not shown in
 * full. Matches where the built-in view puts the same affordance.
 */
function renderRowActions(path: string): HTMLButtonElement {
    const button = element('button', `${className('icon-button')} ${className('tree-actions')}`);
    button.type = 'button';
    button.title = 'More actions';
    button.setAttribute('aria-label', `More actions for ${path}`);
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.appendChild(ellipsisIcon());

    button.addEventListener('click', () => {
        if (button.getAttribute('aria-expanded') === 'true') {
            closeMenu();
            return;
        }

        openMenu(button, [{
            items: [{
                label: 'Copy full path',
                onChoose: () => { copyText(path); },
            }],
        }]);
    });

    return button;
}

/** A row and the actions beside it, sharing one highlight. */
function renderLine(row: HTMLElement, actions?: HTMLElement): HTMLElement {
    const line = element('div', className('tree-line'));
    line.appendChild(row);
    if (actions !== undefined) {
        line.appendChild(actions);
    }
    return line;
}

function renderNode(
    node: FileTreeNode,
    depth: number,
    options: FileTreeViewOptions,
    selection: { current: HTMLElement | undefined }): HTMLElement {
    const item = element('li', className('tree-item'));
    item.setAttribute('role', 'treeitem');

    if (node.kind === 'file') {
        const row = renderRow(node, depth, undefined);
        row.classList.add(className('tree-row--file'));
        row.title = node.path;

        const line = renderLine(row, renderRowActions(node.path));
        row.addEventListener('click', () => {
            const previous = selection.current;
            previous?.classList.remove(className('tree-row--selected'));
            // The highlight is drawn on the line, so both have to be cleared together.
            previous?.parentElement?.classList.remove(className('tree-line--selected'));
            row.classList.add(className('tree-row--selected'));
            line.classList.add(className('tree-line--selected'));
            selection.current = row;
            options.onSelect(node.path);
        });

        item.appendChild(line);
        return item;
    }

    const row = renderRow(node, depth, EXPANDED_GLYPH);
    row.classList.add(className('tree-row--folder'));
    item.setAttribute('aria-expanded', 'true');

    const group = element('ul', className('tree-group'));
    group.setAttribute('role', 'group');
    for (const child of node.children) {
        group.appendChild(renderNode(child, depth + 1, options, selection));
    }

    row.addEventListener('click', () => {
        const expanded = group.hidden;
        group.hidden = !expanded;
        item.setAttribute('aria-expanded', String(expanded));
        const glyph = row.querySelector(`.${className('tree-glyph')}`);
        if (glyph !== null) {
            glyph.textContent = expanded ? EXPANDED_GLYPH : COLLAPSED_GLYPH;
        }
    });

    item.appendChild(renderLine(row));
    item.appendChild(group);
    return item;
}

export function renderFileTree(options: FileTreeViewOptions): HTMLElement {
    const container = element('div', className('tree-container'));

    const search = element('input', className('tree-search'));
    search.type = 'search';
    search.placeholder = 'Find a file or folder';
    search.setAttribute('aria-label', 'Find a file or folder');
    container.appendChild(search);

    const tree = element('ul', className('tree-root'));
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', 'Files in this review');
    container.appendChild(tree);

    const selection: { current: HTMLElement | undefined } = { current: undefined };

    const draw = (): void => {
        tree.textContent = '';
        const visible = filterFileTree(options.nodes, search.value);

        if (visible.length === 0) {
            tree.appendChild(element('li', className('empty'), 'No matching files.'));
            return;
        }

        for (const node of visible) {
            tree.appendChild(renderNode(node, 0, options, selection));
        }
    };

    search.addEventListener('input', draw);
    draw();

    return container;
}
