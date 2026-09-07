/**
 * Reads TFVC code review discussions from the collection's REST API.
 *
 *     GET {collectionUri}/_apis/discussion/threads?workItemId={id}&api-version=3.0-preview.1
 *
 * This returns exactly what Visual Studio's Code Review page shows: every thread for the review,
 * with its file path and line anchor, and every comment with its author resolved and its `parentId`
 * intact for replies.
 *
 * There is a SOAP service that serves the same data (see docs/api-contract.md), and it is what
 * Visual Studio itself calls. It is not usable from here: extension content runs in a sandboxed
 * frame whose requests are cross-origin, and the SOAP endpoint rejects the extension's access token
 * with 401 no matter which scopes are requested. The REST surface accepts that token, so this is
 * both the simpler and the only workable option from a browser.
 */

/** Where a thread is anchored within a file. */
export interface ReviewThreadPosition {
    readonly startLine: number;
    readonly endLine: number;
    readonly startColumn: number | undefined;
    readonly endColumn: number | undefined;
    /** `RightBuffer` for the reviewed side, `LeftBuffer` for the base side. */
    readonly positionContext: string | undefined;
}

export interface ReviewCommentAuthor {
    readonly id: string;
    readonly displayName: string;
    readonly uniqueName: string | undefined;
    readonly imageUrl: string | undefined;
}

export interface ReviewComment {
    readonly id: number;
    readonly threadId: number;
    /** Undefined for a root comment; otherwise the id of the comment being replied to. */
    readonly parentId: number | undefined;
    readonly author: ReviewCommentAuthor;
    readonly content: string;
    readonly publishedDate: string;
    readonly isDeleted: boolean;
}

/** Which of the three levels a thread sits at. */
export type ReviewThreadLevel = 'review' | 'file' | 'code';

export interface ReviewThread {
    readonly id: number;
    readonly artifactUri: string | undefined;
    readonly level: ReviewThreadLevel;
    /** Server path of the file. Absent on review-level threads. */
    readonly itemPath: string | undefined;
    /** Present only on code-block-level threads. */
    readonly position: ReviewThreadPosition | undefined;
    readonly status: string | undefined;
    readonly isDeleted: boolean;
    readonly publishedDate: string | undefined;
    readonly lastUpdatedDate: string | undefined;
    readonly comments: readonly ReviewComment[];
}

/** Minimal shape of `fetch`, so tests can supply a stub. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** One request/response pair, for the diagnostics view. */
export interface RestExchange {
    readonly url: string;
    readonly status: number;
    readonly responseText: string;
}

export interface DiscussionRestClientOptions {
    /** Root URI of the collection. A trailing slash is tolerated. */
    readonly collectionUri: string;
    readonly fetch?: FetchLike;
    /**
     * Supplies the full `Authorization` header value, for example `Basic <base64>`.
     *
     * Requests out of the extension frame are cross-origin and answered with
     * `Access-Control-Allow-Origin: *`, which CORS forbids combining with credentials, so cookies
     * cannot be used. A delegated extension token is refused by this endpoint, so what remains is
     * the user's own personal access token. See docs/api-contract.md.
     */
    readonly getAuthorizationHeader?: () => Promise<string | undefined>;
    readonly onExchange?: (exchange: RestExchange) => void;
    /**
     * Whether to send cookies. Defaults to `omit`.
     *
     * `include` only works where the extension frame is same-origin with the collection, which is
     * not the case by default: Azure DevOps sandboxes extension content without `allow-same-origin`,
     * giving it an opaque origin. On a server whose sandbox attribute has been changed to include
     * `allow-same-origin`, cookies work and Windows authentication applies with no token at all.
     */
    readonly credentials?: RequestCredentials;
}

export class DiscussionRestError extends Error {
    public constructor(
        message: string,
        public readonly status: number | undefined,
        public readonly responseText: string | undefined) {
        super(message);
        this.name = 'DiscussionRestError';
    }
}

const API_VERSION = '3.0-preview.1';

const ITEM_PATH_PROPERTY = 'Microsoft.TeamFoundation.Discussion.ItemPath';
const POSITION_PROPERTY_PREFIX = 'Microsoft.TeamFoundation.Discussion.Position.';

/**
 * Thread properties arrive as `{ "$type": "System.Int32", "$value": 117 }` rather than plain values.
 */
function readProperty(properties: unknown, key: string): unknown {
    if (!properties || typeof properties !== 'object') {
        return undefined;
    }
    const entry = (properties as Record<string, unknown>)[key];
    if (!entry || typeof entry !== 'object') {
        return undefined;
    }
    return (entry as Record<string, unknown>).$value;
}

function readNumberProperty(properties: unknown, key: string): number | undefined {
    const value = readProperty(properties, key);
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function readStringProperty(properties: unknown, key: string): string | undefined {
    const value = readProperty(properties, key);
    return value === undefined || value === null ? undefined : String(value);
}

function toPosition(properties: unknown): ReviewThreadPosition | undefined {
    const startLine = readNumberProperty(properties, `${POSITION_PROPERTY_PREFIX}StartLine`);
    if (startLine === undefined) {
        return undefined;
    }

    return {
        startLine,
        // An anchor always has an end, but be forgiving: a thread pinned to a single line is more
        // useful than no thread at all.
        endLine: readNumberProperty(properties, `${POSITION_PROPERTY_PREFIX}EndLine`) ?? startLine,
        startColumn: readNumberProperty(properties, `${POSITION_PROPERTY_PREFIX}StartColumn`),
        endColumn: readNumberProperty(properties, `${POSITION_PROPERTY_PREFIX}EndColumn`),
        positionContext: readStringProperty(properties, `${POSITION_PROPERTY_PREFIX}PositionContext`),
    };
}

function toAuthor(raw: unknown): ReviewCommentAuthor {
    const author = (raw ?? {}) as Record<string, unknown>;
    const id = typeof author.id === 'string' ? author.id : '';
    return {
        id,
        // Falls back to the raw identifier rather than showing nothing, which is what happens for an
        // account that has since been removed from the collection.
        displayName: typeof author.displayName === 'string' && author.displayName
            ? author.displayName
            : (typeof author.uniqueName === 'string' && author.uniqueName ? author.uniqueName : id),
        uniqueName: typeof author.uniqueName === 'string' ? author.uniqueName : undefined,
        imageUrl: typeof author.imageUrl === 'string' ? author.imageUrl : undefined,
    };
}

function toComment(raw: unknown, threadId: number): ReviewComment {
    const comment = (raw ?? {}) as Record<string, unknown>;
    const parentId = Number(comment.parentId);
    return {
        id: Number(comment.id),
        threadId: Number(comment.threadId ?? threadId),
        // The API omits parentId on root comments and uses 0 in some payloads; both mean "no parent".
        parentId: Number.isFinite(parentId) && parentId > 0 ? parentId : undefined,
        author: toAuthor(comment.author),
        content: typeof comment.content === 'string' ? comment.content : '',
        publishedDate: typeof comment.publishedDate === 'string' ? comment.publishedDate : '',
        isDeleted: comment.isDeleted === true,
    };
}

function toThread(raw: unknown): ReviewThread {
    const thread = (raw ?? {}) as Record<string, unknown>;
    const id = Number(thread.id);
    const itemPath = readStringProperty(thread.properties, ITEM_PATH_PROPERTY);
    const position = toPosition(thread.properties);

    return {
        id,
        artifactUri: typeof thread.artifactUri === 'string' ? thread.artifactUri : undefined,
        // There is no level field; it is implied by which anchors are present.
        level: itemPath === undefined ? 'review' : (position === undefined ? 'file' : 'code'),
        itemPath,
        position,
        status: typeof thread.status === 'string' ? thread.status : undefined,
        isDeleted: thread.isDeleted === true,
        publishedDate: typeof thread.publishedDate === 'string' ? thread.publishedDate : undefined,
        lastUpdatedDate: typeof thread.lastUpdatedDate === 'string' ? thread.lastUpdatedDate : undefined,
        comments: Array.isArray(thread.comments)
            ? thread.comments.map((comment) => toComment(comment, id))
            : [],
    };
}

/**
 * Projects an already-parsed REST payload into review threads.
 *
 * Accepts either the raw `{ count, value }` envelope or a bare array, because the platform's REST
 * client can unwrap collections before handing them back.
 */
export function parseThreads(payload: unknown): readonly ReviewThread[] {
    const value = Array.isArray(payload)
        ? payload
        : (payload as Record<string, unknown> | null)?.value;

    if (!Array.isArray(value)) {
        throw new DiscussionRestError(
            'The response did not contain a thread collection.',
            undefined,
            typeof payload === 'string' ? payload : JSON.stringify(payload));
    }

    return value.map(toThread);
}

/** Projects a raw REST response body into review threads. */
export function parseThreadsResponse(responseText: string): readonly ReviewThread[] {
    let payload: unknown;
    try {
        payload = JSON.parse(responseText);
    } catch (error) {
        throw new DiscussionRestError(
            `The response could not be parsed as JSON: ${(error as Error).message}`,
            undefined,
            responseText);
    }

    return parseThreads(payload);
}

/**
 * Builds an `Authorization` header for a personal access token.
 *
 * Azure DevOps expects the token as the password of an empty user name.
 */
export function buildPersonalAccessTokenHeader(personalAccessToken: string): string {
    return `Basic ${btoa(`:${personalAccessToken}`)}`;
}

export function resolveThreadsUrl(collectionUri: string, workItemId: number): string {
    if (!collectionUri) {
        throw new Error('A collection URI is required to locate the discussion service.');
    }
    return `${collectionUri.replace(/\/+$/, '')}/_apis/discussion/threads`
        + `?workItemId=${encodeURIComponent(String(workItemId))}&api-version=${API_VERSION}`;
}

/** The same threads route without a filter, which is where a new thread is posted. */
export function resolveThreadsCreateUrl(collectionUri: string): string {
    if (!collectionUri) {
        throw new Error('A collection URI is required to locate the discussion service.');
    }
    return `${collectionUri.replace(/\/+$/, '')}/_apis/discussion/threads`
        + `?api-version=${API_VERSION}`;
}

/** Where a new thread is anchored. Omit `position` for a comment on the file as a whole. */
export interface NewThreadAnchor {
    /** Server path of the file the comment is about. */
    readonly itemPath: string;
    readonly position?: NewThreadPosition;
}

export interface NewThreadPosition {
    readonly startLine: number;
    /** Inclusive, so a comment on one line has `startLine === endLine`. */
    readonly endLine: number;
    readonly side: 'base' | 'reviewed';
    /** Character offsets of the range, written to match Visual Studio. Optional; see below. */
    readonly startCharPosition?: number;
    readonly endCharPosition?: number;
}

export interface NewThreadRequest {
    readonly workItemId: number;
    /**
     * The review's artifact URI, which the service requires and calls `VersionUri`.
     *
     * Read it off an existing thread on the same review rather than building it: it embeds the
     * shelveset owner as `DOMAIN\user` and is encoded twice, while the work item stores only the
     * owner's GUID. Every review has at least its description thread to take it from.
     */
    readonly artifactUri: string;
    readonly content: string;
    /** Absent for a thread about the review itself rather than about a file. */
    readonly anchor?: NewThreadAnchor;
}

const ITEM_PATH_PROPERTY_TYPE = 'System.String';
const INTEGER_PROPERTY_TYPE = 'System.Int32';

function stringProperty(value: string): { $type: string; $value: string } {
    return { $type: ITEM_PATH_PROPERTY_TYPE, $value: value };
}

function integerProperty(value: number): { $type: string; $value: number } {
    return { $type: INTEGER_PROPERTY_TYPE, $value: value };
}

/**
 * Builds the `properties` bag for a new thread.
 *
 * Two conventions have to be honored exactly, both established against Visual Studio's own threads
 * and verified by writing and reading back:
 *
 *   * properties are wrapped as `{ $type, $value }` on the way in as well as out, and
 *   * the position is a text *selection*, whose end is exclusive. A comment on lines 10 to 12
 *     inclusive is written as `StartLine 10, EndLine 13` with both columns at 1 -- the selection runs
 *     to the first character of line 13 without including any of it.
 */
export function buildThreadProperties(anchor: NewThreadAnchor | undefined): Record<string, unknown> {
    if (anchor === undefined) {
        return {};
    }

    const properties: Record<string, unknown> = {
        [ITEM_PATH_PROPERTY]: stringProperty(anchor.itemPath),
    };

    const position = anchor.position;
    if (position === undefined) {
        return properties;
    }

    const endLine = Math.max(position.endLine, position.startLine);
    properties[`${POSITION_PROPERTY_PREFIX}StartLine`] = integerProperty(position.startLine);
    properties[`${POSITION_PROPERTY_PREFIX}EndLine`] = integerProperty(endLine + 1);
    properties[`${POSITION_PROPERTY_PREFIX}StartColumn`] = integerProperty(1);
    properties[`${POSITION_PROPERTY_PREFIX}EndColumn`] = integerProperty(1);
    properties[`${POSITION_PROPERTY_PREFIX}PositionContext`] =
        stringProperty(position.side === 'base' ? 'LeftBuffer' : 'RightBuffer');

    // Accepted but not required by the service. Written when the caller could work them out, purely
    // so a thread from here is byte-for-byte what Visual Studio would have written.
    if (position.startCharPosition !== undefined) {
        properties[`${POSITION_PROPERTY_PREFIX}StartCharPosition`] =
            integerProperty(position.startCharPosition);
    }
    if (position.endCharPosition !== undefined) {
        properties[`${POSITION_PROPERTY_PREFIX}EndCharPosition`] =
            integerProperty(position.endCharPosition);
    }

    return properties;
}

/** Route for the comments of one thread, which is both where they are read and where one is added. */
export function resolveCommentsUrl(collectionUri: string, threadId: number): string {
    if (!collectionUri) {
        throw new Error('A collection URI is required to locate the discussion service.');
    }
    return `${collectionUri.replace(/\/+$/, '')}`
        + `/_apis/discussion/threads/${encodeURIComponent(String(threadId))}/comments`
        + `?api-version=${API_VERSION}`;
}

function requirePositiveInteger(value: number, description: string): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`'${value}' is not a valid ${description}.`);
    }
}

export class DiscussionRestClient {
    private readonly options: DiscussionRestClientOptions;

    public constructor(options: DiscussionRestClientOptions) {
        this.options = options;
    }

    /** Returns every thread on a Code Review Request work item. */
    public async queryByCodeReviewRequest(workItemId: number): Promise<readonly ReviewThread[]> {
        requirePositiveInteger(workItemId, 'work item ID');

        return parseThreadsResponse(await this.send(
            resolveThreadsUrl(this.options.collectionUri, workItemId),
            'GET',
            'Reading discussion threads'));
    }

    /**
     * Adds a reply to an existing thread and returns the comment the server created.
     *
     * `parentCommentId` is what threads the reply: it is the same field the viewer reads back to nest
     * replies underneath the comment they answer. The server assigns the new comment's id and dates,
     * and updates the thread's `lastUpdatedDate`, so none of that is sent.
     */
    public async reply(
        threadId: number,
        parentCommentId: number,
        content: string): Promise<ReviewComment> {
        requirePositiveInteger(threadId, 'thread ID');
        requirePositiveInteger(parentCommentId, 'parent comment ID');

        const trimmed = content.trim();
        if (trimmed === '') {
            throw new Error('A reply cannot be empty.');
        }

        const responseText = await this.send(
            resolveCommentsUrl(this.options.collectionUri, threadId),
            'POST',
            'Posting a reply',
            { content: trimmed, parentId: parentCommentId, commentType: 'text' });

        let payload: unknown;
        try {
            payload = JSON.parse(responseText);
        } catch (error) {
            throw new DiscussionRestError(
                `The reply was posted but the response could not be parsed as JSON: `
                + `${(error as Error).message}`,
                undefined,
                responseText);
        }

        return toComment(payload, threadId);
    }

    /**
     * Creates a thread and returns it as the server recorded it.
     *
     * This is what a comment *on* something is: replying adds to an existing thread, while commenting
     * on a file or on a block of code starts a new one.
     */
    public async createThread(request: NewThreadRequest): Promise<ReviewThread> {
        requirePositiveInteger(request.workItemId, 'work item ID');

        if (!request.artifactUri) {
            throw new Error(
                'The review\'s artifact URI is required to create a thread. It is read from an '
                + 'existing thread on the same review.');
        }

        const trimmed = request.content.trim();
        if (trimmed === '') {
            throw new Error('A comment cannot be empty.');
        }

        const responseText = await this.send(
            resolveThreadsCreateUrl(this.options.collectionUri),
            'POST',
            'Posting a comment',
            {
                workItemId: request.workItemId,
                artifactUri: request.artifactUri,
                status: 'active',
                properties: buildThreadProperties(request.anchor),
                comments: [{ content: trimmed, commentType: 'text' }],
            });

        let payload: unknown;
        try {
            payload = JSON.parse(responseText);
        } catch (error) {
            throw new DiscussionRestError(
                'The comment was posted but the response could not be parsed as JSON: '
                + `${(error as Error).message}`,
                undefined,
                responseText);
        }

        return toThread(payload);
    }

    /** Issues one request, reporting the exchange and turning a failure into a DiscussionRestError. */
    private async send(
        url: string,
        method: 'GET' | 'POST',
        description: string,
        body?: unknown): Promise<string> {
        const fetchImplementation = this.options.fetch ?? ((target, init) => fetch(target, init));

        const headers: Record<string, string> = { Accept: 'application/json' };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }
        if (this.options.getAuthorizationHeader) {
            const authorization = await this.options.getAuthorizationHeader();
            if (authorization) {
                headers.Authorization = authorization;
            }
        }

        let response: Response;
        try {
            response = await fetchImplementation(url, {
                method,
                headers,
                credentials: this.options.credentials ?? 'omit',
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        } catch (error) {
            throw new DiscussionRestError(
                `The request to ${url} failed: ${(error as Error).message}`, undefined, undefined);
        }

        const responseText = await response.text();

        if (this.options.onExchange) {
            try {
                this.options.onExchange({ url, status: response.status, responseText });
            } catch {
                // Reporting the exchange must never break the call itself.
            }
        }

        if (!response.ok) {
            throw new DiscussionRestError(
                `${description} failed with HTTP ${response.status} ${response.statusText}.`,
                response.status,
                responseText);
        }

        return responseText;
    }
}

/** Builds the reply tree for a thread. Root comments first, each followed by its replies. */
export function buildReplyTree(
    comments: readonly ReviewComment[]): readonly { comment: ReviewComment; depth: number }[] {
    const childrenByParent = new Map<number | undefined, ReviewComment[]>();
    for (const comment of comments) {
        const siblings = childrenByParent.get(comment.parentId) ?? [];
        siblings.push(comment);
        childrenByParent.set(comment.parentId, siblings);
    }

    const ordered: { comment: ReviewComment; depth: number }[] = [];
    const visited = new Set<number>();

    const visit = (parentId: number | undefined, depth: number): void => {
        const children = (childrenByParent.get(parentId) ?? []).slice().sort((a, b) => a.id - b.id);
        for (const child of children) {
            // Guards against a malformed payload where parentId forms a cycle, which would
            // otherwise recurse until the stack gives out.
            if (visited.has(child.id)) {
                continue;
            }
            visited.add(child.id);
            ordered.push({ comment: child, depth });
            visit(child.id, depth + 1);
        }
    };

    visit(undefined, 0);

    // Anything unreachable from a root (an orphaned reply whose parent was deleted) is still worth
    // showing, at the top level, rather than silently dropped.
    for (const comment of comments) {
        if (!visited.has(comment.id)) {
            visited.add(comment.id);
            ordered.push({ comment, depth: 0 });
        }
    }

    return ordered;
}
