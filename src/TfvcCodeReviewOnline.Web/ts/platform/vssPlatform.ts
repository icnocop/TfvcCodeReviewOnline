/**
 * The only module that talks to the Azure DevOps extension SDK.
 *
 * Everything else in this extension is plain TypeScript against narrow interfaces, so the logic can
 * be unit-tested without a platform host. This file supplies the real implementations of those
 * interfaces and is the single place to change if the host API ever moves.
 */

// Namespace imports rather than `import x = require(...)`: the latter is an import assignment,
// which is rejected when the repository-wide type check runs with ES module semantics, and these
// platform modules expose named exports so a namespace import is equivalent under AMD emit.
import * as TfvcContracts from 'TFS/VersionControl/Contracts';
import * as TfvcRestClient from 'TFS/VersionControl/TfvcRestClient';
import * as WorkItemTrackingServices from 'TFS/WorkItemTracking/Services';

import type {
    RawTfvcChange,
    TfvcChangeSource,
    TfvcContentSource,
    TfvcVersion,
} from '../clients/tfvcClient';
import type { DiffViewMode } from '../model/diffRows';
import type { WorkItemFieldReader, WorkItemFieldWriter } from '../clients/workItemContext';

/** Root URI of the current team project collection, always with no trailing slash. */
export function getCollectionUri(): string {
    const collectionUri = VSS.getWebContext().collection.uri;
    if (!collectionUri) {
        throw new Error('The host did not supply a collection URI.');
    }
    return collectionUri.replace(/\/+$/, '');
}

/** Name of the current team project, which version control URLs are scoped to. */
export function getProjectName(): string {
    return VSS.getWebContext().project?.name ?? '';
}

const PERSONAL_ACCESS_TOKEN_KEY = 'personalAccessToken';

// Stored per user, never per account: a personal access token is that person's credential and must
// not be readable by anyone else who has the extension installed.
const USER_SCOPED: IDocumentOptions = { scopeType: 'User' };

async function getExtensionDataService(): Promise<IExtensionDataService> {
    return await VSS.getService<IExtensionDataService>(VSS.ServiceIds.ExtensionData);
}

/**
 * Returns the personal access token this user has supplied, if any.
 *
 * On a stock server this is the only credential a browser extension can use to read code review
 * comments: the discussion API refuses a delegated extension token while accepting a personal access
 * token for the identical request. See docs/api-contract.md, and docs/installing.md for the
 * server-side change that removes the need for a token.
 */
export async function getStoredPersonalAccessToken(): Promise<string | undefined> {
    try {
        const service = await getExtensionDataService();
        const stored = await service.getValue<string>(PERSONAL_ACCESS_TOKEN_KEY, USER_SCOPED);
        return stored ? stored : undefined;
    } catch {
        // A missing value throws in some host versions; treat that as "not set yet".
        return undefined;
    }
}

export async function setStoredPersonalAccessToken(token: string): Promise<void> {
    const service = await getExtensionDataService();
    await service.setValue<string>(PERSONAL_ACCESS_TOKEN_KEY, token, USER_SCOPED);
}

const PREFERENCES_KEY = 'preferences';

/**
 * How the reader likes the tab laid out.
 *
 * Held as one value rather than one key per setting: each key costs a round trip to the extension
 * data service on load, and these are always read together and always written together.
 */
export interface ViewPreferences {
    readonly diffViewMode?: DiffViewMode;
    readonly wordWrap?: boolean;
    readonly ignoreWhitespace?: boolean;
    readonly treeWidth?: number;
    readonly treeCollapsed?: boolean;
}

/**
 * Last known preferences, so a write does not have to read first.
 *
 * Each setting is changed by its own control, and without this a change to one would write back
 * whatever the others were when the page loaded -- which is fine until two controls are used in the
 * same session, at which point the earlier change is quietly undone.
 */
let cachedPreferences: ViewPreferences = {};

function parsePreferences(stored: string | undefined): ViewPreferences {
    if (!stored) {
        return {};
    }
    const raw = JSON.parse(stored) as Record<string, unknown>;
    return {
        diffViewMode: raw.diffViewMode === 'inline' || raw.diffViewMode === 'sideBySide'
            ? raw.diffViewMode
            : undefined,
        wordWrap: typeof raw.wordWrap === 'boolean' ? raw.wordWrap : undefined,
        ignoreWhitespace: typeof raw.ignoreWhitespace === 'boolean'
            ? raw.ignoreWhitespace
            : undefined,
        treeWidth: typeof raw.treeWidth === 'number' ? raw.treeWidth : undefined,
        treeCollapsed: typeof raw.treeCollapsed === 'boolean' ? raw.treeCollapsed : undefined,
    };
}

export async function getViewPreferences(): Promise<ViewPreferences> {
    try {
        const service = await getExtensionDataService();
        cachedPreferences = parsePreferences(
            await service.getValue<string>(PREFERENCES_KEY, USER_SCOPED));
    } catch {
        // Missing, or written by a version that stored something else. The defaults apply.
        cachedPreferences = {};
    }
    return cachedPreferences;
}

/** Merges a change into the stored preferences, leaving the others as they were. */
export async function updateViewPreferences(change: ViewPreferences): Promise<void> {
    cachedPreferences = { ...cachedPreferences, ...change };
    try {
        const service = await getExtensionDataService();
        await service.setValue<string>(
            PREFERENCES_KEY, JSON.stringify(cachedPreferences), USER_SCOPED);
    } catch {
        // Failing to remember a layout preference is not worth interrupting anyone over.
    }
}
/** Resolves the host's work item form service, narrowed to the fields the extension reads. */
export async function getWorkItemFieldReader(): Promise<WorkItemFieldReader> {
    const service = await WorkItemTrackingServices.WorkItemFormService.getService();
    return {
        getId: () => service.getId(),
        getFieldValues: (fieldReferenceNames) => service.getFieldValues(fieldReferenceNames),
    };
}

/**
 * The same form service, narrowed to what closing a review needs.
 *
 * This is the only place the extension writes to a work item, and it writes through the form the
 * reader is looking at rather than through the REST API -- so the work item type's rules apply, the
 * form shows the change, and the saved revision is the one the form holds.
 */
export async function getWorkItemFieldWriter(): Promise<WorkItemFieldWriter> {
    const service = await WorkItemTrackingServices.WorkItemFormService.getService();
    return {
        setFieldValues: (fields) => service.setFieldValues(fields as IDictionaryStringTo<Object>),
        save: () => service.save(),
    };
}

/**
 * Wraps Microsoft's TFVC REST client as the change source the review loader expects.
 *
 * `getClient` returns a client already scoped to the current collection and already wired to the
 * host's authentication, which is why this extension has no REST plumbing of its own.
 *
 * That authentication is a delegated token rather than the reader's cookies, so the `vso.code` scope
 * in vss-extension.json is load-bearing: without it every call here fails with TF400813. This holds
 * even where the frame has been made same-origin -- that change lets our own `fetch` send cookies,
 * but the platform's REST clients go on using an auth token manager regardless.
 *
 * The token does represent the signed-in reader, restricted to the declared scopes, so permissions
 * are still theirs; the identity named in that TF400813 is the reader's own. The scope is a ceiling
 * on what may be done on their behalf, and removing it to "tidy up" leaves a token that can do
 * nothing at all.
 */
export function getTfvcChangeSource(): TfvcChangeSource {
    const client = TfvcRestClient.getClient();
    return {
        getShelvesetChanges: async (shelvesetId): Promise<readonly RawTfvcChange[]> =>
            (await client.getShelvesetChanges(shelvesetId)) as readonly RawTfvcChange[],
        getChangesetChanges: async (changesetId): Promise<readonly RawTfvcChange[]> =>
            (await client.getChangesetChanges(changesetId)) as readonly RawTfvcChange[],
    };
}

function toVersionDescriptor(version: TfvcVersion): TfvcContracts.TfvcVersionDescriptor {
    return {
        version: version.version,
        versionOption: TfvcContracts.TfvcVersionOption.None,
        versionType: version.versionType === 'Shelveset'
            ? TfvcContracts.TfvcVersionType.Shelveset
            : TfvcContracts.TfvcVersionType.Changeset,
    };
}

/**
 * Reads file content through the same TFVC client.
 *
 * A shelveset version is addressed as `name;owner`, and the owner may be given either as a domain
 * account or as an identity GUID. The GUID form is the one used here, because that is what the work
 * item stores; both are accepted on this route, unlike `/_apis/tfvc/shelvesets/{id}`, which requires
 * the GUID.
 */
export function getTfvcContentSource(): TfvcContentSource {
    const client = TfvcRestClient.getClient();
    return {
        getFileText: (path, version) => client.getItemText(
            path,
            /* project */ undefined,
            /* fileName */ undefined,
            /* download */ false,
            /* scopePath */ undefined,
            /* recursionLevel */ undefined,
            toVersionDescriptor(version),
            /* includeContent */ true),
    };
}
