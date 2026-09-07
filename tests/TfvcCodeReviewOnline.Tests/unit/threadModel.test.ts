import { describe, expect, it } from 'vitest';

import {
    describeThreadAnchor,
    describeThreadStatus,
    findFileThreads,
    groupThreads,
    isThreadResolved,
    normalizeItemPath,
    visibleComments,
} from '../../../src/TfvcCodeReviewOnline.Web/ts/model/threadModel';
import { comment, position, thread } from './support/reviewFixtures';

describe('isThreadResolved', () => {
    it('recognizes the statuses that mean a thread is done', () => {
        expect(isThreadResolved(thread({ status: 'closed' }))).toBe(true);
        expect(isThreadResolved(thread({ status: 'fixed' }))).toBe(true);
        expect(isThreadResolved(thread({ status: 'wontFix' }))).toBe(true);
        expect(isThreadResolved(thread({ status: 'byDesign' }))).toBe(true);
    });

    it('treats anything else, including a missing status, as still open', () => {
        // A thread wrongly counted as needing attention costs a badge; one wrongly hidden from the
        // count costs the reader a comment they were meant to act on.
        expect(isThreadResolved(thread({ status: 'active' }))).toBe(false);
        expect(isThreadResolved(thread({ status: 'pending' }))).toBe(false);
        expect(isThreadResolved(thread({ status: undefined }))).toBe(false);
        expect(isThreadResolved(thread({ status: 'somethingNew' }))).toBe(false);
    });
});

describe('visibleComments', () => {
    it('drops comments their author deleted', () => {
        const withDeleted = thread({
            comments: [comment({ id: 1 }), comment({ id: 2, isDeleted: true })],
        });

        expect(visibleComments(withDeleted).map((entry) => entry.id)).toEqual([1]);
    });
});

describe('normalizeItemPath', () => {
    it('compares paths the way TFVC does', () => {
        expect(normalizeItemPath('$/Project/Src/File.cs'))
            .toBe(normalizeItemPath('$/project/src/file.cs'));
    });

    it('treats a backslash and a forward slash as the same separator', () => {
        expect(normalizeItemPath('$/Project\\Src\\File.cs'))
            .toBe(normalizeItemPath('$/Project/Src/File.cs'));
    });
});

describe('groupThreads', () => {
    it('separates review-level threads from the ones about a file', () => {
        const grouped = groupThreads([
            thread({ id: 1, itemPath: undefined }),
            thread({ id: 2, itemPath: '$/Project/A.cs' }),
            thread({ id: 3, itemPath: '$/Project/A.cs', position: position() }),
        ]);

        expect(grouped.reviewThreads.map((entry) => entry.id)).toEqual([1]);
        expect(grouped.files).toHaveLength(1);
        expect(grouped.files[0].fileThreads.map((entry) => entry.id)).toEqual([2]);
        expect(grouped.files[0].codeThreads.map((entry) => entry.id)).toEqual([3]);
    });

    it('orders anchored threads by where they sit in the file', () => {
        const grouped = groupThreads([
            thread({ id: 1, position: position({ startLine: 200, endLine: 200 }) }),
            thread({ id: 2, position: position({ startLine: 10, endLine: 12 }) }),
            thread({ id: 3, position: position({ startLine: 50, endLine: 50 }) }),
        ]);

        expect(grouped.files[0].codeThreads.map((entry) => entry.id)).toEqual([2, 3, 1]);
    });

    it('gathers threads on one file even when they disagree about casing', () => {
        // The discussion service and version control are separate stores, so the same file can be
        // recorded with different casing. Matching on the raw string would split the file in two.
        const grouped = groupThreads([
            thread({ id: 1, itemPath: '$/Project/Sample.cs', position: position() }),
            thread({ id: 2, itemPath: '$/project/sample.cs', position: position() }),
        ]);

        expect(grouped.files).toHaveLength(1);
        expect(grouped.files[0].codeThreads).toHaveLength(2);
    });

    it('counts unresolved threads per file and across the review', () => {
        const grouped = groupThreads([
            thread({ id: 1, itemPath: undefined, status: 'active' }),
            thread({ id: 2, itemPath: '$/Project/A.cs', status: 'closed' }),
            thread({ id: 3, itemPath: '$/Project/A.cs', status: 'active', position: position() }),
            thread({ id: 4, itemPath: '$/Project/B.cs', status: 'fixed' }),
        ]);

        expect(grouped.total).toBe(4);
        expect(grouped.unresolved).toBe(2);

        const fileA = findFileThreads(grouped, '$/Project/A.cs');
        expect(fileA?.total).toBe(2);
        expect(fileA?.unresolved).toBe(1);
        expect(findFileThreads(grouped, '$/Project/B.cs')?.unresolved).toBe(0);
    });

    it('leaves out a thread whose every comment was deleted', () => {
        const grouped = groupThreads([
            thread({ id: 1, comments: [comment({ isDeleted: true })] }),
            thread({ id: 2, isDeleted: true }),
            thread({ id: 3 }),
        ]);

        expect(grouped.total).toBe(1);
        expect(grouped.files[0].fileThreads.map((entry) => entry.id)).toEqual([3]);
    });

    it('orders files by path so the list does not move between loads', () => {
        const grouped = groupThreads([
            thread({ id: 1, itemPath: '$/Project/Zeta.cs' }),
            thread({ id: 2, itemPath: '$/Project/Alpha.cs' }),
        ]);

        expect(grouped.files.map((file) => file.path))
            .toEqual(['$/Project/Alpha.cs', '$/Project/Zeta.cs']);
    });

    it('reports nothing for a review with no threads', () => {
        const grouped = groupThreads([]);

        expect(grouped.total).toBe(0);
        expect(grouped.unresolved).toBe(0);
        expect(grouped.files).toEqual([]);
        expect(grouped.reviewThreads).toEqual([]);
    });
});

describe('findFileThreads', () => {
    it('matches a path regardless of casing', () => {
        const grouped = groupThreads([thread({ itemPath: '$/Project/Sample.cs' })]);

        expect(findFileThreads(grouped, '$/PROJECT/SAMPLE.CS')?.total).toBe(1);
    });

    it('returns nothing for a file no one has commented on', () => {
        const grouped = groupThreads([thread({ itemPath: '$/Project/Sample.cs' })]);

        expect(findFileThreads(grouped, '$/Project/Other.cs')).toBeUndefined();
    });
});

describe('describeThreadAnchor', () => {
    it('names a single line', () => {
        expect(describeThreadAnchor(946, 946)).toBe('Line 946');
    });

    it('names a range', () => {
        expect(describeThreadAnchor(117, 129)).toBe('Lines 117-129');
    });

    it('says nothing about a thread with no anchor', () => {
        expect(describeThreadAnchor(undefined, undefined)).toBe('');
    });
});

describe('describeThreadStatus', () => {
    it('turns a camel-case status into words', () => {
        expect(describeThreadStatus(thread({ status: 'wontFix' }))).toBe('Wont fix');
        expect(describeThreadStatus(thread({ status: 'closed' }))).toBe('Closed');
    });

    it('says nothing about an active thread, because they all are', () => {
        // Verified across 669 threads on a real collection: every one is active, because the Visual
        // Studio code review page has no per-thread resolve action. Labelling them all "ACTIVE"
        // decorates every thread identically, which is noise dressed as information.
        expect(describeThreadStatus(thread({ status: 'active' }))).toBe('');
        expect(describeThreadStatus(thread({ status: ' Active ' }))).toBe('');
    });

    it('says nothing when the service reported no status', () => {
        expect(describeThreadStatus(thread({ status: undefined }))).toBe('');
        expect(describeThreadStatus(thread({ status: '  ' }))).toBe('');
    });
});
