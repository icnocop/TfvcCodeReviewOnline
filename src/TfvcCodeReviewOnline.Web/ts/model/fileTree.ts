/**
 * Arranges the review's files into a folder tree.
 *
 * The one thing this does beyond the obvious is **collapse chains of single-child folders**. TFVC
 * server paths are long -- `$/Project/dev/Component/Source/Area/Thing/File.cs` is ordinary -- and a
 * literal tree of them is a column of folders each containing exactly one folder, where every level
 * costs a line and an indent and tells the reader nothing. Joining those runs into one node
 * (`$/Project/dev/Component/Source`) turns an unusable ladder into a tree whose shape actually
 * reflects where the review branches.
 */

export interface FileTreeInput {
    /** Full server path, for example `$/Project/src/File.cs`. */
    readonly path: string;
    readonly threadCount: number;
    /**
     * Whether the review deletes this file.
     *
     * Stated as a fact about the file rather than as a TFVC change type, so the tree keeps knowing
     * nothing about version control vocabulary.
     */
    readonly deleted?: boolean;
}

export interface FileTreeNode {
    readonly kind: 'folder' | 'file';
    /** Label to show. A folder's may join several path segments that never branch. */
    readonly name: string;
    /** Full server path of the file, or of the folder this node stands for. */
    readonly path: string;
    readonly children: readonly FileTreeNode[];
    /** Threads on this file, or on everything beneath this folder. */
    readonly threadCount: number;
    /**
     * Whether the review deletes this file. Always false for a folder: a folder that happens to hold
     * nothing but deletions is not itself being removed, and saying so would be a claim the review
     * does not make.
     */
    readonly deleted: boolean;
}

interface MutableFolder {
    readonly children: Map<string, MutableFolder>;
    readonly files: { name: string; input: FileTreeInput }[];
}

function emptyFolder(): MutableFolder {
    return { children: new Map<string, MutableFolder>(), files: [] };
}

/** Folders before files, each alphabetically and without regard to case, as Windows would. */
function compareNodes(left: FileTreeNode, right: FileTreeNode): number {
    if (left.kind !== right.kind) {
        return left.kind === 'folder' ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
}

function toFolderNode(name: string, folder: MutableFolder, parentPath: string): FileTreeNode {
    let displayName = name;
    let path = parentPath === '' ? name : `${parentPath}/${name}`;
    let current = folder;

    // Absorb every folder that is an only child and has no files of its own.
    while (current.files.length === 0 && current.children.size === 1) {
        const [childName, child] = Array.from(current.children.entries())[0];
        displayName = `${displayName}/${childName}`;
        path = `${path}/${childName}`;
        current = child;
    }

    const children = toNodes(current, path);
    return {
        kind: 'folder',
        name: displayName,
        path,
        children,
        threadCount: children.reduce((total, child) => total + child.threadCount, 0),
        deleted: false,
    };
}

function toNodes(folder: MutableFolder, parentPath: string): readonly FileTreeNode[] {
    const nodes: FileTreeNode[] = [];

    for (const [name, child] of Array.from(folder.children.entries())) {
        nodes.push(toFolderNode(name, child, parentPath));
    }

    for (const file of folder.files) {
        nodes.push({
            kind: 'file',
            name: file.name,
            path: file.input.path,
            children: [],
            threadCount: file.input.threadCount,
            deleted: file.input.deleted === true,
        });
    }

    return nodes.sort(compareNodes);
}

export function buildFileTree(files: readonly FileTreeInput[]): readonly FileTreeNode[] {
    const root = emptyFolder();

    for (const file of files) {
        const segments = file.path.split('/').filter((segment) => segment.length > 0);
        if (segments.length === 0) {
            // Nothing to place in a tree, and dropping it is better than an unnamed node.
            continue;
        }

        const fileName = segments[segments.length - 1];
        let current = root;
        for (const segment of segments.slice(0, -1)) {
            let next = current.children.get(segment);
            if (next === undefined) {
                next = emptyFolder();
                current.children.set(segment, next);
            }
            current = next;
        }
        current.files.push({ name: fileName, input: file });
    }

    return toNodes(root, '');
}

/**
 * Narrows the tree to the files whose path contains the given text.
 *
 * Matching is on the whole path rather than the file name, so a folder name narrows to everything
 * under it -- which is how someone with a hundred files in front of them usually thinks about finding
 * one. A folder survives if anything beneath it does.
 */
export function filterFileTree(
    nodes: readonly FileTreeNode[],
    query: string): readonly FileTreeNode[] {
    const needle = query.trim().toLowerCase();
    if (needle === '') {
        return nodes;
    }

    const keep: FileTreeNode[] = [];
    for (const node of nodes) {
        if (node.kind === 'file') {
            if (node.path.toLowerCase().indexOf(needle) >= 0) {
                keep.push(node);
            }
            continue;
        }

        // A folder whose own name matches keeps everything under it; otherwise only its matches.
        const children = node.path.toLowerCase().indexOf(needle) >= 0
            ? node.children
            : filterFileTree(node.children, query);

        if (children.length > 0) {
            keep.push({ ...node, children });
        }
    }

    return keep;
}

/** Every file node in the tree, in the order it is rendered. */
export function flattenFiles(nodes: readonly FileTreeNode[]): readonly FileTreeNode[] {
    const files: FileTreeNode[] = [];
    const visit = (current: readonly FileTreeNode[]): void => {
        for (const node of current) {
            if (node.kind === 'file') {
                files.push(node);
            } else {
                visit(node.children);
            }
        }
    };
    visit(nodes);
    return files;
}
