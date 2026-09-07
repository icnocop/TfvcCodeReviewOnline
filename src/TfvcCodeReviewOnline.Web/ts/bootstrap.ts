/**
 * Entry point for the work item form tab.
 *
 * The one rule this file enforces: nothing thrown here escapes. Any failure is caught, rendered as
 * an in-tab error panel, and reported to the host as a *successful* load, so the host never sits
 * waiting on a load callback that will not arrive. A user should be able to read what went wrong
 * without opening developer tools, and the rest of the work item form should be unaffected.
 */

import {
    buildPersonalAccessTokenHeader,
    DiscussionRestClient,
    DiscussionRestError,
    type RestExchange,
    type ReviewThread,
} from './clients/discussionRestClient';
import { listReviewedFiles, loadFileContent, type ReviewedFile } from './clients/tfvcClient';
import { closeReview, readReviewContext } from './clients/workItemContext';
import {
    getCollectionUri,
    getProjectName,
    getStoredPersonalAccessToken,
    getTfvcChangeSource,
    getTfvcContentSource,
    getViewPreferences,
    getWorkItemFieldReader,
    getWorkItemFieldWriter,
    setStoredPersonalAccessToken,
    updateViewPreferences,
} from './platform/vssPlatform';
import { renderReview } from './view/reviewView';
import {
    renderError,
    renderNotACodeReview,
    renderPersonalAccessTokenPrompt,
} from './view/statusView';

const HOST_ELEMENT_ID = 'content';

function hostElement(): HTMLElement {
    const host = document.getElementById(HOST_ELEMENT_ID);
    if (!host) {
        throw new Error(`The page is missing its #${HOST_ELEMENT_ID} container.`);
    }
    return host;
}

async function saveTokenAndReload(host: HTMLElement, personalAccessToken: string): Promise<void> {
    try {
        await setStoredPersonalAccessToken(personalAccessToken);
        await load();
    } catch (error) {
        renderError(host, error);
    }
}

async function loadReviewedFiles(
    target: Parameters<typeof listReviewedFiles>[1]): Promise<{
        files: readonly ReviewedFile[];
        error: string | undefined;
    }> {
    // A missing or deleted shelveset must not prevent the comments from being shown: the threads are
    // the point, and the file list is context. So this failure is reported inline rather than
    // failing the whole load.
    try {
        return { files: await listReviewedFiles(getTfvcChangeSource(), target), error: undefined };
    } catch (error) {
        return { files: [], error: error instanceof Error ? error.message : String(error) };
    }
}

async function load(): Promise<void> {
    const host = hostElement();

    const reviewContext = await readReviewContext(await getWorkItemFieldReader());
    if (!reviewContext.isCodeReviewRequest) {
        // The manifest cannot restrict a contribution to one work item type, so the guard is applied
        // here. Note that in the on-premises XML process model the tab appears only on work item
        // types whose definition places the page contribution, so in practice this empty state is a
        // safety net rather than something users normally see.
        renderNotACodeReview(host, reviewContext.workItemType);
        return;
    }

    const collectionUri = getCollectionUri();
    let exchange: RestExchange | undefined;
    const onExchange = (recorded: RestExchange): void => { exchange = recorded; };

    /*
     * Two ways to authenticate, tried in this order.
     *
     * Cookies work only where the extension frame is same-origin with the collection. By default it
     * is not: Azure DevOps sandboxes extension content without `allow-same-origin`, so the frame has
     * an opaque origin, requests are cross-origin, and the collection's `Access-Control-Allow-Origin:
     * *` cannot be combined with credentials. On a server whose sandbox attribute has been changed
     * to include `allow-same-origin`, cookies work and Windows authentication applies with nothing
     * to configure.
     *
     * Otherwise the user's own personal access token is the only credential available, because the
     * discussion API refuses a delegated extension token while accepting a personal access token for
     * the identical request. See docs/api-contract.md.
     */
    const personalAccessToken = await getStoredPersonalAccessToken();
    const client = personalAccessToken
        ? new DiscussionRestClient({
            collectionUri,
            getAuthorizationHeader: () =>
                Promise.resolve(buildPersonalAccessTokenHeader(personalAccessToken)),
            onExchange,
        })
        : new DiscussionRestClient({ collectionUri, credentials: 'include', onExchange });

    let threads: readonly ReviewThread[];
    try {
        threads = await client.queryByCodeReviewRequest(reviewContext.workItemId);
    } catch (error) {
        // Falling back rather than failing: on a stock server the cookie attempt above cannot
        // succeed, and asking for a token is the way forward rather than a dead end.
        if (!personalAccessToken) {
            renderPersonalAccessTokenPrompt(host, {
                collectionUri,
                onSave: (token) => { void saveTokenAndReload(host, token); },
            });
            return;
        }

        // A rejected token is the expected failure once one expires or was mistyped, and it needs a
        // way out rather than a dead end.
        if (error instanceof DiscussionRestError && (error.status === 401 || error.status === 403)) {
            renderPersonalAccessTokenPrompt(host, {
                collectionUri,
                message: 'That personal access token was rejected. It may have expired, or it may '
                    + 'not have read access to Work Items and Code.',
                onSave: (token) => { void saveTokenAndReload(host, token); },
            });
            return;
        }

        // Probe the TFVC REST API before giving up. It goes through the platform's own client and
        // its own credentials, so whether it succeeds separates a broken connection to the server
        // from a problem specific to reading discussions.
        const probe = await loadReviewedFiles(reviewContext.target);
        const restOutcome = probe.error === undefined
            ? `The TFVC REST call succeeded (${probe.files.length} changed file(s)), so the `
                + 'connection to the collection is fine.'
            : `The TFVC REST call also failed: ${probe.error}`;

        renderError(
            host,
            error,
            [restOutcome, exchange?.responseText].filter((part) => part).join('\n\n'));
        return;
    }

    const reviewedFiles = await loadReviewedFiles(reviewContext.target);
    const contentSource = getTfvcContentSource();
    const preferences = await getViewPreferences();

    /*
     * The review's artifact URI, taken from a thread rather than built.
     *
     * The service requires it on every new thread and calls it `VersionUri`. It embeds the shelveset
     * owner as `DOMAIN\user` and is encoded twice, while the work item stores only the owner's GUID,
     * so reproducing it would mean resolving an identity and matching that encoding exactly. Every
     * review carries at least its description thread, so reading it off one is both simpler and
     * exactly right. A review with no thread at all leaves the tab read-only, which is the honest
     * outcome: there is nothing to derive it from.
     */
    const artifactUri = threads.filter((thread) => thread.artifactUri)[0]?.artifactUri;

    renderReview(host, {
        reviewContext,
        threads,
        files: reviewedFiles.files,
        filesError: reviewedFiles.error,
        collectionUri,
        projectName: getProjectName(),
        // Content, not a finished diff: the view re-diffs when a display option changes, and that
        // must not mean fetching both versions of the file again.
        loadFileContent: (file) => loadFileContent(contentSource, file),
        initialViewMode: preferences.diffViewMode,
        onViewModeChanged: (mode) => { void updateViewPreferences({ diffViewMode: mode }); },
        initialWordWrap: preferences.wordWrap,
        onWordWrapChanged: (wrap) => { void updateViewPreferences({ wordWrap: wrap }); },
        initialIgnoreWhitespace: preferences.ignoreWhitespace,
        onIgnoreWhitespaceChanged: (ignore) => {
            void updateViewPreferences({ ignoreWhitespace: ignore });
        },
        treePane: { width: preferences.treeWidth, collapsed: preferences.treeCollapsed },
        onTreePaneChanged: (layout) => {
            void updateViewPreferences({
                treeWidth: layout.width,
                treeCollapsed: layout.collapsed,
            });
        },
        /*
         * The one thing this extension writes to the work item.
         *
         * Offered only on an open review: closing is a one-way transition, so a control on a closed
         * one would be an offer the server refuses. The view checks the same thing; this is here so
         * that a host which cannot write simply supplies nothing.
         */
        closer: reviewContext.isClosed ? undefined : {
            close: async (closure, comment) =>
                closeReview(await getWorkItemFieldWriter(), closure, comment),
        },
        writer: artifactUri === undefined ? undefined : {
            reply: (threadId, parentCommentId, content) =>
                client.reply(threadId, parentCommentId, content),
            createThread: (anchor, content) => client.createThread({
                workItemId: reviewContext.workItemId,
                artifactUri,
                content,
                anchor,
            }),
        },
    });
}

/*
 * There is deliberately no call to `VSS.resize` anywhere in this file.
 *
 * The obvious design -- measure the content, ask the host to grow the frame to fit -- was tried and
 * does not work here. The host honors the request: the frame really does become as tall as the
 * review. But it sits inside a fixed-height container with `overflow: hidden`, so the frame grows,
 * the container clips it, and no scrollbar appears anywhere, because the clipping hides the overflow
 * from every ancestor that might otherwise have scrolled. Growing the frame also breaks the fallback
 * meant to cover exactly this case: `100vh` inside a frame is the frame's own height, so inflating
 * the frame inflates the clamp with it.
 *
 * The frame is therefore left at whatever height the host gives it, and the review scrolls inside
 * that -- which is what the host's fixed, clipping container is asking for. See wwwroot/css/app.css.
 */

export function run(): void {
    load()
        .catch((error: unknown) => {
            try {
                renderError(document.getElementById(HOST_ELEMENT_ID) ?? document.body, error);
            } catch {
                // If even the error panel cannot be rendered there is nothing further to try, and
                // throwing from here would only produce an unhandled rejection.
            }
        })
        .then(() => {
            // Always reported as succeeded: the tab has finished doing what it can, and telling the
            // host it failed makes the host show its own error chrome instead of the message this
            // tab renders to explain what went wrong.
            VSS.notifyLoadSucceeded();
        });
}
