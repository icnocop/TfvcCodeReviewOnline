import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
    buildPersonalAccessTokenHeader,
    buildReplyTree,
    DiscussionRestClient,
    DiscussionRestError,
    parseThreads,
    parseThreadsResponse,
    resolveCommentsUrl,
    resolveThreadsUrl,
    type FetchLike,
    type RestExchange,
    type ReviewThread,
} from '../../../src/TfvcCodeReviewOnline.Web/ts/clients/discussionRestClient';

const FIXTURES_DIRECTORY = join(__dirname, '..', 'fixtures');
const COLLECTION_URI = 'https://tfs.example.com/DefaultCollection';

function readFixture(fileName: string): string {
    return readFileSync(join(FIXTURES_DIRECTORY, fileName), 'utf8');
}

function threads(): readonly ReviewThread[] {
    return parseThreadsResponse(readFixture('discussionThreads.response.json'));
}

function threadById(id: number): ReviewThread {
    const thread = threads().find((candidate) => candidate.id === id);
    if (!thread) {
        throw new Error(`Fixture has no thread ${id}.`);
    }
    return thread;
}

function fakeResponse(
    body: string,
    overrides: { ok?: boolean; status?: number; statusText?: string } = {}): Response {
    return {
        ok: overrides.ok ?? true,
        status: overrides.status ?? 200,
        statusText: overrides.statusText ?? 'OK',
        text: () => Promise.resolve(body),
    } as unknown as Response;
}

describe('resolveThreadsUrl', () => {
    it('queries by work item ID', () => {
        // The route is keyed by work item, which is what makes this usable at all: the artifact-URI
        // form of the same route returns nothing for a code review.
        expect(resolveThreadsUrl(COLLECTION_URI, 1234)).toBe(
            `${COLLECTION_URI}/_apis/discussion/threads?workItemId=1234&api-version=3.0-preview.1`);
    });

    it('tolerates a trailing slash on the collection URI', () => {
        expect(resolveThreadsUrl(`${COLLECTION_URI}/`, 1234))
            .toBe(resolveThreadsUrl(COLLECTION_URI, 1234));
    });

    it('rejects an empty collection URI', () => {
        expect(() => resolveThreadsUrl('', 1234)).toThrow(/collection URI is required/);
    });
});

describe('buildPersonalAccessTokenHeader', () => {
    it('sends the token as the password of an empty user name', () => {
        // Azure DevOps expects ":<token>" base64-encoded; putting the token in the user name field
        // instead produces a 401 that looks exactly like an expired token.
        expect(buildPersonalAccessTokenHeader('sample-token'))
            .toBe(`Basic ${Buffer.from(':sample-token', 'binary').toString('base64')}`);
    });
});

describe('parseThreadsResponse', () => {
    it('reads every thread', () => {
        expect(threads()).toHaveLength(5);
    });

    it('classifies review-, file-, and code-block-level threads', () => {
        expect(threadById(4001).level).toBe('review');
        expect(threadById(4001).itemPath).toBeUndefined();

        expect(threadById(4002).level).toBe('file');
        expect(threadById(4002).itemPath).toBe('$/ExampleProject/src/Sample1.csproj');
        expect(threadById(4002).position).toBeUndefined();

        expect(threadById(4003).level).toBe('code');
    });

    it('unwraps the line anchor from the $type/$value property envelope', () => {
        // Thread properties are not plain values; each is { "$type": ..., "$value": ... }.
        expect(threadById(4003).position).toEqual({
            startLine: 117,
            endLine: 129,
            startColumn: 21,
            endColumn: 22,
            positionContext: 'RightBuffer',
        });
    });

    it('reads an anchor on the base side of the diff', () => {
        expect(threadById(4004).position?.positionContext).toBe('LeftBuffer');
        expect(threadById(4004).position?.startLine).toBe(946);
    });

    it('defaults a missing end line to the start line rather than dropping the anchor', () => {
        const parsed = parseThreadsResponse(JSON.stringify({
            value: [{
                id: 1,
                comments: [],
                properties: {
                    'Microsoft.TeamFoundation.Discussion.ItemPath': { $value: '$/ExampleProject/a.cs' },
                    'Microsoft.TeamFoundation.Discussion.Position.StartLine': { $value: 10 },
                },
            }],
        }));

        expect(parsed[0].position).toEqual({
            startLine: 10,
            endLine: 10,
            startColumn: undefined,
            endColumn: undefined,
            positionContext: undefined,
        });
    });

    it('reads comment content, dates, and the deleted flag', () => {
        const comment = threadById(4005).comments[0];

        expect(comment.content).toBe('Withdrawn.');
        expect(comment.isDeleted).toBe(true);
        expect(threadById(4005).status).toBe('closed');
    });

    it('preserves multi-line content and decoded entities', () => {
        const [root, reply] = threadById(4003).comments;

        expect(root.content).toBe(
            'Why would this fail, and why does the code keep going afterwards?\r\n'
            + 'It looks like the error is swallowed here, so a later call would fail instead.');
        expect(reply.content).toBe('Good catch & agreed - the "continue" was deliberate but wrong.');
    });

    it('treats an absent parentId as a root comment', () => {
        const comments = threadById(4003).comments;

        expect(comments[0].parentId).toBeUndefined();
        expect(comments[1].parentId).toBe(1);
        expect(comments[2].parentId).toBe(2);
    });

    it('resolves author display names, and falls back for an author that has none', () => {
        expect(threadById(4003).comments[0].author.displayName).toBe('Sample User 2');
        expect(threadById(4001).comments[0].author.imageUrl).toContain('MemberAvatars');

        // Happens for an account removed from the collection; showing the raw id beats showing
        // nothing at all.
        expect(threadById(4004).comments[0].author.displayName)
            .toBe('00000000-0000-4000-8000-000000000003');
    });

    it('returns an empty list for a review with no threads', () => {
        expect(parseThreadsResponse(JSON.stringify({ count: 0, value: [] }))).toEqual([]);
    });

    it('rejects a response that is not JSON', () => {
        expect(() => parseThreadsResponse('<html>Sign in</html>')).toThrowError(DiscussionRestError);
    });

    it('rejects a JSON response with no thread collection', () => {
        expect(() => parseThreadsResponse(JSON.stringify({ message: 'nope' })))
            .toThrow(/did not contain a thread collection/);
    });
});

describe('buildReplyTree', () => {
    it('nests replies under the comment they answer', () => {
        const ordered = buildReplyTree(threadById(4003).comments);

        expect(ordered.map((entry) => [entry.comment.id, entry.depth])).toEqual([
            [1, 0],
            [2, 1],
            [3, 2],
        ]);
    });

    it('places sibling replies at the same depth in id order', () => {
        const comments = threadById(4003).comments.map(
            (comment) => (comment.id === 3 ? { ...comment, parentId: 1 } : comment));

        const ordered = buildReplyTree(comments);

        expect(ordered.map((entry) => [entry.comment.id, entry.depth])).toEqual([
            [1, 0],
            [2, 1],
            [3, 1],
        ]);
    });

    it('still shows a reply whose parent is missing', () => {
        // An orphan is dropped entirely by a naive tree walk; losing a comment silently is worse
        // than showing it at the top level.
        const orphan = threadById(4003).comments.filter((comment) => comment.id !== 1);

        const ordered = buildReplyTree(orphan);

        expect(ordered.map((entry) => entry.comment.id).sort()).toEqual([2, 3]);
    });

    it('does not recurse forever on a cyclic parent chain', () => {
        const cyclic = [
            { ...threadById(4003).comments[1], id: 1, parentId: 2 },
            { ...threadById(4003).comments[2], id: 2, parentId: 1 },
        ];

        const ordered = buildReplyTree(cyclic);

        expect(ordered).toHaveLength(2);
    });
});

describe('DiscussionRestClient', () => {
    it('requests the threads for a work item with the supplied credential and no cookies', async () => {
        const fetchStub = vi.fn<FetchLike>().mockResolvedValue(
            fakeResponse(readFixture('discussionThreads.response.json')));

        const client = new DiscussionRestClient({
            collectionUri: COLLECTION_URI,
            fetch: fetchStub,
            getAuthorizationHeader: () => Promise.resolve('Basic c2FtcGxl'),
        });
        const result = await client.queryByCodeReviewRequest(1234);

        expect(result).toHaveLength(5);
        const [url, init] = fetchStub.mock.calls[0];
        expect(url).toBe(resolveThreadsUrl(COLLECTION_URI, 1234));
        // Cookies would make the browser reject the wildcard-origin CORS response outright.
        expect(init.credentials).toBe('omit');
        expect((init.headers as Record<string, string>).Authorization).toBe('Basic c2FtcGxl');
    });

    it('can send cookies instead, for a server whose extension frame is same-origin', async () => {
        // Only works where the sandbox attribute includes allow-same-origin. On a stock server the
        // frame has an opaque origin and this attempt fails, which is why it is a first try with a
        // token fallback rather than the only path.
        const fetchStub = vi.fn<FetchLike>().mockResolvedValue(
            fakeResponse(readFixture('discussionThreads.response.json')));

        await new DiscussionRestClient({
            collectionUri: COLLECTION_URI,
            fetch: fetchStub,
            credentials: 'include',
        }).queryByCodeReviewRequest(1234);

        const [, init] = fetchStub.mock.calls[0];
        expect(init.credentials).toBe('include');
        expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    });

    it('accepts a bare array, not just the count/value envelope', async () => {
        const payload = JSON.parse(readFixture('discussionThreads.response.json')).value;

        expect(parseThreads(payload)).toHaveLength(5);
    });

    it('reports the exchange for the diagnostics view', async () => {
        const body = readFixture('discussionThreads.response.json');
        const fetchStub = vi.fn<FetchLike>().mockResolvedValue(fakeResponse(body));
        const exchanges: { url: string; status: number }[] = [];

        await new DiscussionRestClient({
            collectionUri: COLLECTION_URI,
            fetch: fetchStub,
            onExchange: (exchange) => exchanges.push(exchange),
        }).queryByCodeReviewRequest(1234);

        expect(exchanges).toHaveLength(1);
        expect(exchanges[0].status).toBe(200);
    });

    it('surfaces the status on an error response', async () => {
        const fetchStub = vi.fn<FetchLike>().mockResolvedValue(
            fakeResponse('Unauthorized', { ok: false, status: 401, statusText: 'Unauthorized' }));

        const client = new DiscussionRestClient({ collectionUri: COLLECTION_URI, fetch: fetchStub });

        await expect(client.queryByCodeReviewRequest(1234)).rejects.toThrow(/HTTP 401 Unauthorized/);
    });

    it('reports a rejected fetch rather than throwing something opaque', async () => {
        const fetchStub = vi.fn<FetchLike>().mockRejectedValue(new Error('NetworkError'));

        const client = new DiscussionRestClient({ collectionUri: COLLECTION_URI, fetch: fetchStub });

        await expect(client.queryByCodeReviewRequest(1234)).rejects.toThrowError(DiscussionRestError);
    });

    it('rejects a work item ID that cannot identify a review', async () => {
        const client = new DiscussionRestClient({ collectionUri: COLLECTION_URI });

        await expect(client.queryByCodeReviewRequest(0)).rejects.toThrow(/not a valid work item ID/);
        await expect(client.queryByCodeReviewRequest(1.5)).rejects.toThrow(/not a valid work item ID/);
    });
});

describe('resolveCommentsUrl', () => {
    it('addresses the comments of one thread', () => {
        expect(resolveCommentsUrl('https://tfs.example.com/DefaultCollection', 21760))
            .toBe('https://tfs.example.com/DefaultCollection'
                + '/_apis/discussion/threads/21760/comments?api-version=3.0-preview.1');
    });

    it('tolerates a trailing slash on the collection URI', () => {
        expect(resolveCommentsUrl('https://tfs.example.com/DefaultCollection/', 1))
            .toContain('/DefaultCollection/_apis/discussion/threads/1/comments');
    });
});

describe('DiscussionRestClient.reply', () => {
    const CREATED_COMMENT = JSON.stringify({
        id: 2,
        parentId: 1,
        threadId: 21760,
        author: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Sample User 1' },
        content: 'Agreed, fixed.',
        publishedDate: '2026-04-07T12:00:00.000Z',
        commentType: 'text',
    });

    function recordingFetch(responseText: string, status = 200): {
        fetch: FetchLike;
        calls: { url: string; init: RequestInit }[];
    } {
        const calls: { url: string; init: RequestInit }[] = [];
        return {
            calls,
            fetch: (url, init) => {
                calls.push({ url, init });
                return Promise.resolve(new Response(responseText, { status }));
            },
        };
    }

    it('posts the content, the parent, and nothing the server assigns', async () => {
        // Sending an id, an author, or a date would either be ignored or fight the server for
        // ownership of fields it is the only thing able to set correctly.
        const recorder = recordingFetch(CREATED_COMMENT);
        const client = new DiscussionRestClient({
            collectionUri: 'https://tfs.example.com/DefaultCollection',
            fetch: recorder.fetch,
        });

        await client.reply(21760, 1, 'Agreed, fixed.');

        const [call] = recorder.calls;
        expect(call.init.method).toBe('POST');
        expect(call.url).toContain('/_apis/discussion/threads/21760/comments');
        expect(JSON.parse(String(call.init.body))).toEqual({
            content: 'Agreed, fixed.',
            parentId: 1,
            commentType: 'text',
        });
        expect((call.init.headers as Record<string, string>)['Content-Type'])
            .toBe('application/json');
    });

    it('returns the comment the server created', async () => {
        const client = new DiscussionRestClient({
            collectionUri: 'https://tfs.example.com/DefaultCollection',
            fetch: recordingFetch(CREATED_COMMENT).fetch,
        });

        const comment = await client.reply(21760, 1, 'Agreed, fixed.');

        expect(comment.id).toBe(2);
        expect(comment.parentId).toBe(1);
        expect(comment.threadId).toBe(21760);
        expect(comment.author.displayName).toBe('Sample User 1');
        expect(comment.isDeleted).toBe(false);
    });

    it('trims the content before sending it', async () => {
        const recorder = recordingFetch(CREATED_COMMENT);
        const client = new DiscussionRestClient({
            collectionUri: 'https://tfs.example.com/DefaultCollection',
            fetch: recorder.fetch,
        });

        await client.reply(21760, 1, '  Agreed, fixed.\n  ');

        expect(JSON.parse(String(recorder.calls[0].init.body)).content).toBe('Agreed, fixed.');
    });

    it('refuses to post an empty reply', async () => {
        const recorder = recordingFetch(CREATED_COMMENT);
        const client = new DiscussionRestClient({
            collectionUri: 'https://tfs.example.com/DefaultCollection',
            fetch: recorder.fetch,
        });

        await expect(client.reply(21760, 1, '   \n ')).rejects.toThrow('cannot be empty');
        expect(recorder.calls).toEqual([]);
    });

    it('rejects an unusable thread or parent before making a request', async () => {
        const recorder = recordingFetch(CREATED_COMMENT);
        const client = new DiscussionRestClient({
            collectionUri: 'https://tfs.example.com/DefaultCollection',
            fetch: recorder.fetch,
        });

        await expect(client.reply(0, 1, 'text')).rejects.toThrow('thread ID');
        await expect(client.reply(21760, 0, 'text')).rejects.toThrow('parent comment ID');
        expect(recorder.calls).toEqual([]);
    });

    it('reports a rejected write with its status and body', async () => {
        const client = new DiscussionRestClient({
            collectionUri: 'https://tfs.example.com/DefaultCollection',
            fetch: recordingFetch('{"message":"TF401027: You need the Contribute permission."}', 403).fetch,
        });

        const error = await client.reply(21760, 1, 'text').catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(DiscussionRestError);
        expect((error as DiscussionRestError).status).toBe(403);
        expect((error as DiscussionRestError).message).toContain('Posting a reply failed');
        expect((error as DiscussionRestError).responseText).toContain('TF401027');
    });

    it('sends the authorization header when one is supplied', async () => {
        const recorder = recordingFetch(CREATED_COMMENT);
        const client = new DiscussionRestClient({
            collectionUri: 'https://tfs.example.com/DefaultCollection',
            getAuthorizationHeader: () => Promise.resolve('Basic dGVzdA=='),
            fetch: recorder.fetch,
        });

        await client.reply(21760, 1, 'text');

        expect((recorder.calls[0].init.headers as Record<string, string>).Authorization)
            .toBe('Basic dGVzdA==');
    });

    it('reports the exchange so a failure can be shown to the reader', async () => {
        const exchanges: RestExchange[] = [];
        const client = new DiscussionRestClient({
            collectionUri: 'https://tfs.example.com/DefaultCollection',
            fetch: recordingFetch(CREATED_COMMENT).fetch,
            onExchange: (exchange) => { exchanges.push(exchange); },
        });

        await client.reply(21760, 1, 'text');

        expect(exchanges).toHaveLength(1);
        expect(exchanges[0].status).toBe(200);
    });
});
