import { describe, expect, it } from 'vitest';

import {
    buildFileTree,
    filterFileTree,
    flattenFiles,
    type FileTreeNode,
} from '../../../src/TfvcCodeReviewOnline.Web/ts/model/fileTree';

function input(path: string, threadCount = 0): { path: string; threadCount: number } {
    return { path, threadCount };
}

/** Renders the tree as indented lines, so an expectation looks like the tree it describes. */
function outline(nodes: readonly FileTreeNode[], depth = 0): readonly string[] {
    const lines: string[] = [];
    for (const node of nodes) {
        lines.push(`${'  '.repeat(depth)}${node.name}${node.kind === 'folder' ? '/' : ''}`);
        lines.push(...outline(node.children, depth + 1));
    }
    return lines;
}

describe('buildFileTree', () => {
    it('collapses a chain of folders that never branches', () => {
        // TFVC paths are long, and a literal tree of them is a ladder of folders each holding one
        // folder -- every level costing a line and an indent while saying nothing.
        expect(outline(buildFileTree([input('$/Project/dev/Source/Area/File.cs')]))).toEqual([
            '$/Project/dev/Source/Area/',
            '  File.cs',
        ]);
    });

    it('stops collapsing where the tree actually branches', () => {
        expect(outline(buildFileTree([
            input('$/Project/dev/One/A.cs'),
            input('$/Project/dev/Two/B.cs'),
        ]))).toEqual([
            '$/Project/dev/',
            '  One/',
            '    A.cs',
            '  Two/',
            '    B.cs',
        ]);
    });

    it('does not swallow a folder that also holds a file', () => {
        // The folder has one subfolder but a file of its own, so collapsing it would hide the file.
        expect(outline(buildFileTree([
            input('$/Project/Root.cs'),
            input('$/Project/Nested/Leaf.cs'),
        ]))).toEqual([
            '$/Project/',
            '  Nested/',
            '    Leaf.cs',
            '  Root.cs',
        ]);
    });

    it('puts folders before files, each in case-insensitive name order', () => {
        expect(outline(buildFileTree([
            input('$/P/zebra.cs'),
            input('$/P/Apple.cs'),
            input('$/P/Sub/x.cs'),
        ]))).toEqual([
            '$/P/',
            '  Sub/',
            '    x.cs',
            '  Apple.cs',
            '  zebra.cs',
        ]);
    });

    it('keeps the full server path on every file', () => {
        const [root] = buildFileTree([input('$/Project/src/File.cs')]);

        expect(root.children[0].path).toBe('$/Project/src/File.cs');
    });

    it('totals thread counts up through the folders', () => {
        const [root] = buildFileTree([
            input('$/P/One/A.cs', 2),
            input('$/P/One/B.cs', 3),
            input('$/P/Two/C.cs', 1),
        ]);

        expect(root.threadCount).toBe(6);
        expect(root.children.map((child) => `${child.name}=${child.threadCount}`))
            .toEqual(['One=5', 'Two=1']);
    });

    it('reports no threads for a review nobody has commented on', () => {
        const [root] = buildFileTree([input('$/P/A.cs'), input('$/P/B.cs')]);

        expect(root.threadCount).toBe(0);
    });

    it('handles a review with no files', () => {
        expect(buildFileTree([])).toEqual([]);
    });

    it('carries a deletion through to the file it is about', () => {
        const nodes = buildFileTree([
            { path: '$/P/Gone.cs', threadCount: 0, deleted: true },
            { path: '$/P/Stays.cs', threadCount: 0 },
        ]);

        // Both files sit under the one folder the path chain collapses to.
        expect(nodes[0].children.map((node) => `${node.name}:${String(node.deleted)}`))
            .toEqual(['Gone.cs:true', 'Stays.cs:false']);
    });

    it('does not call a folder deleted for holding nothing but deletions', () => {
        // The review removes the files; it says nothing about the folder, and a struck-out folder
        // name would be a claim it never made.
        const nodes = buildFileTree([{ path: '$/P/Old/Gone.cs', threadCount: 0, deleted: true }]);

        expect(nodes[0].kind).toBe('folder');
        expect(nodes[0].deleted).toBe(false);
    });

    it('drops a path with nothing in it rather than making an unnamed node', () => {
        expect(buildFileTree([input(''), input('$/P/A.cs')])).toHaveLength(1);
    });
});

describe('flattenFiles', () => {
    it('lists every file in render order, and no folders', () => {
        const nodes = buildFileTree([
            input('$/P/Two/C.cs'),
            input('$/P/One/A.cs'),
            input('$/P/B.cs'),
        ]);

        expect(flattenFiles(nodes).map((file) => file.name)).toEqual(['A.cs', 'C.cs', 'B.cs']);
        expect(flattenFiles(nodes).every((file) => file.kind === 'file')).toBe(true);
    });
});

describe('filterFileTree', () => {
    const nodes = buildFileTree([
        input('$/P/Devices/AmazonS3/Client.cs'),
        input('$/P/Devices/Local/Store.cs'),
        input('$/P/Web/Startup.cs'),
    ]);

    it('keeps the files whose path contains the text', () => {
        expect(flattenFiles(filterFileTree(nodes, 'startup')).map((file) => file.name))
            .toEqual(['Startup.cs']);
    });

    it('matches on the whole path, so a folder name narrows to its contents', () => {
        // Which is how someone with a hundred files in front of them thinks about finding one.
        expect(flattenFiles(filterFileTree(nodes, 'Devices')).map((file) => file.name))
            .toEqual(['Client.cs', 'Store.cs']);
    });

    it('ignores case', () => {
        expect(flattenFiles(filterFileTree(nodes, 'AMAZONS3'))).toHaveLength(1);
    });

    it('drops a folder with nothing left under it', () => {
        expect(filterFileTree(nodes, "startup")[0].children.map((child: FileTreeNode) => child.name))
            .not.toContain('Devices');
    });

    it('returns everything for an empty or blank query', () => {
        expect(filterFileTree(nodes, '')).toBe(nodes);
        expect(flattenFiles(filterFileTree(nodes, '   '))).toHaveLength(3);
    });

    it('finds nothing when nothing matches', () => {
        expect(filterFileTree(nodes, 'no-such-file')).toEqual([]);
    });
});
