/**
 * Builders for the objects the viewer works with.
 *
 * Threads and comments carry a dozen fields each, and a test that spells all of them out buries the
 * one field it is actually about. These builders supply a valid default for everything so each test
 * can name only what matters to it.
 */

import type {
    ReviewComment,
    ReviewCommentAuthor,
    ReviewThread,
    ReviewThreadPosition,
} from '../../../../src/TfvcCodeReviewOnline.Web/ts/clients/discussionRestClient';
import type { ReviewedFile } from '../../../../src/TfvcCodeReviewOnline.Web/ts/clients/tfvcClient';
import {
    CODE_REVIEW_REQUEST_WORK_ITEM_TYPE,
    type ReviewContext,
} from '../../../../src/TfvcCodeReviewOnline.Web/ts/clients/workItemContext';

export const SAMPLE_PATH = '$/ExampleProject/src/Sample.cs';

export const SHELVESET_ID = 'CodeReview_2026-04-07;00000000-0000-4000-8000-000000000001';

export function author(overrides: Partial<ReviewCommentAuthor> = {}): ReviewCommentAuthor {
    return {
        id: '00000000-0000-4000-8000-000000000001',
        displayName: 'Sample User 1',
        uniqueName: 'sample.user1@example.com',
        imageUrl: undefined,
        ...overrides,
    };
}

export function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
    return {
        id: 1,
        threadId: 4001,
        parentId: undefined,
        author: author(),
        content: 'A sample comment.',
        publishedDate: '2026-04-07T09:15:00.123Z',
        isDeleted: false,
        ...overrides,
    };
}

export function position(overrides: Partial<ReviewThreadPosition> = {}): ReviewThreadPosition {
    return {
        startLine: 3,
        endLine: 3,
        startColumn: undefined,
        endColumn: undefined,
        positionContext: 'RightBuffer',
        ...overrides,
    };
}

/**
 * Builds a thread, inferring its level from the anchors present, exactly as the client does when it
 * parses a response.
 */
export function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
    const itemPath = 'itemPath' in overrides ? overrides.itemPath : SAMPLE_PATH;
    const anchor = 'position' in overrides ? overrides.position : undefined;

    return {
        id: 4001,
        artifactUri: undefined,
        level: itemPath === undefined ? 'review' : (anchor === undefined ? 'file' : 'code'),
        itemPath,
        position: anchor,
        status: 'active',
        isDeleted: false,
        publishedDate: '2026-04-07T09:15:00.123Z',
        lastUpdatedDate: '2026-04-07T09:15:00.123Z',
        comments: [comment()],
        ...overrides,
    };
}

export function reviewedFile(overrides: Partial<ReviewedFile> = {}): ReviewedFile {
    const path = overrides.path ?? SAMPLE_PATH;
    return {
        path,
        basePath: path,
        changeType: 'edit',
        baseVersion: 23112,
        reviewedVersion: { versionType: 'Shelveset', version: SHELVESET_ID },
        ...overrides,
    };
}

export function reviewContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
    return {
        workItemId: 1234,
        workItemType: CODE_REVIEW_REQUEST_WORK_ITEM_TYPE,
        title: 'Adds retry handling around the import step',
        isCodeReviewRequest: true,
        state: 'Requested',
        closedStatus: undefined,
        isClosed: false,
        contextCode: 1,
        contextType: 'Shelveset',
        context: 'CodeReview_2026-04-07',
        contextOwner: '00000000-0000-4000-8000-000000000001',
        target: {
            kind: 'shelveset',
            shelvesetName: 'CodeReview_2026-04-07',
            shelvesetId: SHELVESET_ID,
        },
        ...overrides,
    };
}

/** Lets pending promises and the microtask queue drain before the DOM is asserted on. */
export async function flushAsyncWork(): Promise<void> {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}
