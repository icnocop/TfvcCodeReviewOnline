/**
 * Organizes the flat list of threads the discussion API returns into the shape the viewer renders:
 * review-level threads, then one group per file with its threads ordered by where they sit in it.
 *
 * Pure and free of any DOM or platform dependency, so the grouping and counting rules -- which are
 * what the file badges assert -- are testable on their own.
 */

import type { ReviewComment, ReviewThread } from '../clients/discussionRestClient';

/**
 * Thread statuses that mean the thread needs no further attention.
 *
 * Compared case-insensitively, and anything unrecognized counts as unresolved: a thread wrongly
 * shown as needing attention is a much smaller problem than one wrongly hidden from the count.
 */
const RESOLVED_STATUSES: ReadonlySet<string> = new Set([
    'closed',
    'fixed',
    'resolved',
    'wontfix',
    'bydesign',
]);

export function isThreadResolved(thread: ReviewThread): boolean {
    return thread.status !== undefined && RESOLVED_STATUSES.has(thread.status.trim().toLowerCase());
}

/**
 * Comments worth rendering.
 *
 * A deleted comment is returned by the API with its content intact, and Visual Studio does not show
 * it. Neither does this: someone who withdrew a remark should not find it published in a different
 * client.
 */
export function visibleComments(thread: ReviewThread): readonly ReviewComment[] {
    return thread.comments.filter((comment) => !comment.isDeleted);
}

/** A thread that has something left to show once deleted comments are dropped. */
function isVisible(thread: ReviewThread): boolean {
    return !thread.isDeleted && visibleComments(thread).length > 0;
}

/** Threads attached to one file, split by whether they are anchored to a line range. */
export interface FileThreadGroup {
    /** Server path exactly as the threads report it. */
    readonly path: string;
    /** Threads about the file as a whole. */
    readonly fileThreads: readonly ReviewThread[];
    /** Threads anchored to a line range, ordered by that range. */
    readonly codeThreads: readonly ReviewThread[];
    readonly total: number;
    readonly unresolved: number;
}

export interface GroupedThreads {
    /** Threads about the review rather than about any one file. */
    readonly reviewThreads: readonly ReviewThread[];
    /** One group per file that has at least one thread, ordered by path. */
    readonly files: readonly FileThreadGroup[];
    readonly total: number;
    readonly unresolved: number;
}

/**
 * Key for matching a thread's path against a change's path.
 *
 * TFVC server paths are case-insensitive, and the discussion service and the version control service
 * are separate stores, so the two can disagree on casing for the same file. Matching on the raw
 * string would silently orphan those threads.
 */
export function normalizeItemPath(path: string): string {
    return path.trim().replace(/\\/g, '/').toLowerCase();
}

/** Sorts anchored threads by where they sit in the file, then by id to keep ties stable. */
function compareByAnchor(left: ReviewThread, right: ReviewThread): number {
    const leftStart = left.position?.startLine ?? 0;
    const rightStart = right.position?.startLine ?? 0;
    return leftStart !== rightStart ? leftStart - rightStart : left.id - right.id;
}

export function groupThreads(threads: readonly ReviewThread[]): GroupedThreads {
    const reviewThreads: ReviewThread[] = [];
    const fileThreadsByPath = new Map<string, { path: string; file: ReviewThread[]; code: ReviewThread[] }>();

    for (const thread of threads) {
        if (!isVisible(thread)) {
            continue;
        }

        if (thread.itemPath === undefined) {
            reviewThreads.push(thread);
            continue;
        }

        const key = normalizeItemPath(thread.itemPath);
        let group = fileThreadsByPath.get(key);
        if (group === undefined) {
            group = { path: thread.itemPath, file: [], code: [] };
            fileThreadsByPath.set(key, group);
        }

        if (thread.level === 'code') {
            group.code.push(thread);
        } else {
            group.file.push(thread);
        }
    }

    const files: FileThreadGroup[] = [];
    for (const group of fileThreadsByPath.values()) {
        const fileThreads = group.file.slice().sort((left, right) => left.id - right.id);
        const codeThreads = group.code.slice().sort(compareByAnchor);
        const all = fileThreads.concat(codeThreads);
        files.push({
            path: group.path,
            fileThreads,
            codeThreads,
            total: all.length,
            unresolved: all.filter((thread) => !isThreadResolved(thread)).length,
        });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));

    const total = reviewThreads.length + files.reduce((sum, file) => sum + file.total, 0);
    const unresolved = reviewThreads.filter((thread) => !isThreadResolved(thread)).length
        + files.reduce((sum, file) => sum + file.unresolved, 0);

    return { reviewThreads: reviewThreads.slice().sort((left, right) => left.id - right.id), files, total, unresolved };
}

/** Finds the threads for a file, matching paths the way TFVC compares them. */
export function findFileThreads(
    grouped: GroupedThreads,
    path: string): FileThreadGroup | undefined {
    const key = normalizeItemPath(path);
    return grouped.files.filter((file) => normalizeItemPath(file.path) === key)[0];
}

/** Human-readable name for which of the three levels a thread sits at. */
export function describeThreadLevel(thread: ReviewThread): string {
    return thread.level === 'code' ? 'code block' : thread.level;
}

/** Renders a thread's anchor as a compact line range, for example `117-129`. */
export function describeThreadAnchor(
    startLine: number | undefined,
    endLine: number | undefined): string {
    if (startLine === undefined) {
        return '';
    }
    return endLine !== undefined && endLine !== startLine
        ? `Lines ${startLine}-${endLine}`
        : `Line ${startLine}`;
}

/**
 * Label for a thread's status, or an empty string when saying it would tell the reader nothing.
 *
 * `active` is the only status a TFVC review ever carries -- verified across 669 threads, every one of
 * them active -- because the Visual Studio code review page has no per-thread resolve action. (Its
 * per-file check box is a local, per-user "I have looked at this" marker and has nothing to do with
 * thread state.) Labelling every thread "ACTIVE" therefore decorates them all identically, which is
 * noise wearing the costume of information.
 *
 * Any other value is shown, because that one would genuinely distinguish a thread from its
 * neighbours.
 */
export function describeThreadStatus(thread: ReviewThread): string {
    const status = thread.status?.trim() ?? '';
    if (status === '' || status.toLowerCase() === 'active') {
        return '';
    }
    // Statuses arrive in camel case ("wontFix"); split them into words for display.
    const spaced = status.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
