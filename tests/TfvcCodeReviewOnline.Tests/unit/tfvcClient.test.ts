import { describe, expect, it } from 'vitest';

import {
    describeChangeType,
    isAdd,
    isDelete,
    listReviewedFiles,
    loadFileContent,
    looksBinary,
    type RawTfvcChange,
    type TfvcChangeSource,
    type TfvcContentSource,
    type TfvcVersion,
} from '../../../src/TfvcCodeReviewOnline.Web/ts/clients/tfvcClient';
import type { ReviewTarget } from '../../../src/TfvcCodeReviewOnline.Web/ts/clients/workItemContext';
import { reviewedFile } from './support/reviewFixtures';

function changeSource(changes: readonly RawTfvcChange[]): TfvcChangeSource & {
    shelvesetCalls: string[];
    changesetCalls: number[];
} {
    const shelvesetCalls: string[] = [];
    const changesetCalls: number[] = [];
    return {
        shelvesetCalls,
        changesetCalls,
        getShelvesetChanges: (shelvesetId) => {
            shelvesetCalls.push(shelvesetId);
            return Promise.resolve(changes);
        },
        getChangesetChanges: (changesetId) => {
            changesetCalls.push(changesetId);
            return Promise.resolve(changes);
        },
    };
}

const SHELVESET_TARGET: ReviewTarget = {
    kind: 'shelveset',
    shelvesetName: 'CodeReview_2026-04-07',
    shelvesetId: 'CodeReview_2026-04-07;00000000-0000-4000-8000-000000000001',
};

describe('describeChangeType', () => {
    it('passes through the string form the REST API returns', () => {
        expect(describeChangeType('edit')).toBe('edit');
        expect(describeChangeType('edit, rename')).toBe('edit, rename');
    });

    it('decodes the numeric flags form', () => {
        // The same field is typed as a flags enum in the generated contracts, so both shapes reach
        // this code depending on which client produced the value.
        expect(describeChangeType(2)).toBe('edit');
        expect(describeChangeType(1)).toBe('add');
        expect(describeChangeType(2 | 8)).toBe('edit, rename');
    });

    it('reports anything else as unknown rather than guessing', () => {
        expect(describeChangeType(undefined)).toBe('unknown');
        expect(describeChangeType('')).toBe('unknown');
        expect(describeChangeType(0)).toBe('unknown');
        expect(describeChangeType({})).toBe('unknown');
    });
});

describe('isAdd / isDelete', () => {
    it('recognizes changes with no base side', () => {
        expect(isAdd('add')).toBe(true);
        expect(isAdd('branch')).toBe(true);
        expect(isAdd('edit')).toBe(false);
        // "sourceRename" contains neither word as a whole token and must not be mistaken for one.
        expect(isAdd('sourceRename')).toBe(false);
    });

    it('recognizes changes with no reviewed side', () => {
        expect(isDelete('delete')).toBe(true);
        expect(isDelete('edit, delete')).toBe(true);
        expect(isDelete('undelete')).toBe(false);
    });
});

describe('listReviewedFiles', () => {
    it('queries the shelveset by its owner-GUID identifier', async () => {
        const source = changeSource([
            { changeType: 'edit', item: { path: '$/ExampleProject/src/Sample.cs', version: 23112 } },
        ]);

        await listReviewedFiles(source, SHELVESET_TARGET);

        expect(source.shelvesetCalls).toEqual([SHELVESET_TARGET.shelvesetId]);
        expect(source.changesetCalls).toEqual([]);
    });

    it('records the base changeset as the version to diff against', async () => {
        const source = changeSource([
            { changeType: 'edit', item: { path: '$/ExampleProject/src/Sample.cs', version: 23112 } },
        ]);

        const [file] = await listReviewedFiles(source, SHELVESET_TARGET);

        expect(file.baseVersion).toBe(23112);
        expect(file.reviewedVersion).toEqual({
            versionType: 'Shelveset',
            version: SHELVESET_TARGET.shelvesetId,
        });
    });

    it('gives an added file no base version', async () => {
        // An add has nothing on the left-hand side, so the diff has to render it as all-new rather
        // than fetching a base version that does not exist.
        const source = changeSource([
            { changeType: 'add', item: { path: '$/ExampleProject/src/New.cs', version: 23112 } },
        ]);

        const [file] = await listReviewedFiles(source, SHELVESET_TARGET);

        expect(file.baseVersion).toBeUndefined();
    });

    it('sorts files by path so the list is stable between loads', async () => {
        const source = changeSource([
            { changeType: 'edit', item: { path: '$/ExampleProject/src/Zeta.cs', version: 1 } },
            { changeType: 'edit', item: { path: '$/ExampleProject/src/Alpha.cs', version: 1 } },
        ]);

        const files = await listReviewedFiles(source, SHELVESET_TARGET);

        expect(files.map((file) => file.path)).toEqual([
            '$/ExampleProject/src/Alpha.cs',
            '$/ExampleProject/src/Zeta.cs',
        ]);
    });

    it('drops a change with no server path instead of rendering a blank row', async () => {
        const source = changeSource([
            { changeType: 'edit', item: { version: 1 } },
            { changeType: 'edit', item: { path: '$/ExampleProject/src/Sample.cs', version: 1 } },
        ]);

        const files = await listReviewedFiles(source, SHELVESET_TARGET);

        expect(files).toHaveLength(1);
    });

    it('queries a changeset review by changeset number', async () => {
        const source = changeSource([
            { changeType: 'edit', item: { path: '$/ExampleProject/src/Sample.cs', version: 23112 } },
        ]);

        const files = await listReviewedFiles(source, { kind: 'changeset', changesetId: 23113 });

        expect(source.changesetCalls).toEqual([23113]);
        expect(files[0].reviewedVersion).toEqual({ versionType: 'Changeset', version: '23113' });
    });

    it('explains an unresolvable target', async () => {
        const source = changeSource([]);

        await expect(listReviewedFiles(source, { kind: 'unknown', reason: 'No shelveset name.' }))
            .rejects.toThrow('No shelveset name.');
    });

    it('remembers the old path of a renamed file', async () => {
        // The base version has to be fetched at the name the file had then; asking for the new name
        // at the base changeset would just fail.
        const source = changeSource([{
            changeType: 'edit, rename',
            sourceServerItem: '$/ExampleProject/src/Old.cs',
            item: { path: '$/ExampleProject/src/New.cs', version: 23112 },
        }]);

        const [file] = await listReviewedFiles(source, SHELVESET_TARGET);

        expect(file.path).toBe('$/ExampleProject/src/New.cs');
        expect(file.basePath).toBe('$/ExampleProject/src/Old.cs');
    });

    it('uses the current path as the base path when nothing was renamed', async () => {
        const source = changeSource([
            { changeType: 'edit', item: { path: '$/ExampleProject/src/Sample.cs', version: 1 } },
        ]);

        const [file] = await listReviewedFiles(source, SHELVESET_TARGET);

        expect(file.basePath).toBe(file.path);
    });
});

/*
 * The NUL that marks content as binary, named rather than written inline.
 *
 * A NUL escape written inline straight after a word reads to the environment-leak guard in
 * scripts/Test-NoEnvironmentLeaks.ps1 as a DOMAIN\account literal, because the escape begins with a
 * backslash. That check is worth more than the convenience of an inline escape here.
 */
const NUL = String.fromCharCode(0);

describe('looksBinary', () => {
    it('recognizes content holding a NUL', () => {
        expect(looksBinary(`MZ${NUL}${NUL}some bytes`)).toBe(true);
    });

    it('treats ordinary source text as text', () => {
        expect(looksBinary('using System;\r\n\r\nnamespace Example { }\r\n')).toBe(false);
        expect(looksBinary('')).toBe(false);
    });
});

interface RecordedRequest {
    readonly path: string;
    readonly version: TfvcVersion;
}

function contentSource(
    responses: Readonly<Record<string, string | Error>> = {}): TfvcContentSource & {
        requests: RecordedRequest[];
    } {
    const requests: RecordedRequest[] = [];
    return {
        requests,
        getFileText: (path, version) => {
            requests.push({ path, version });
            const response = responses[`${version.versionType}:${path}`];
            if (response instanceof Error) {
                return Promise.reject(response);
            }
            return Promise.resolve(response ?? '');
        },
    };
}

describe('loadFileContent', () => {
    it('fetches both versions of an edited file', async () => {
        const source = contentSource({
            'Changeset:$/ExampleProject/src/Sample.cs': 'old\n',
            'Shelveset:$/ExampleProject/src/Sample.cs': 'new\n',
        });

        const content = await loadFileContent(source, reviewedFile());

        expect(content.baseText).toBe('old\n');
        expect(content.reviewedText).toBe('new\n');
        expect(content.note).toBeUndefined();
        expect(source.requests.map((request) => request.version.versionType).sort())
            .toEqual(['Changeset', 'Shelveset']);
    });

    it('asks for the base version at the changeset the change was pended against', async () => {
        const source = contentSource();

        await loadFileContent(source, reviewedFile({ baseVersion: 23112 }));

        const base = source.requests.filter((request) => request.version.versionType === 'Changeset');
        expect(base).toHaveLength(1);
        expect(base[0].version.version).toBe('23112');
    });

    it('asks for the base version at the path the file had before a rename', async () => {
        const source = contentSource();

        await loadFileContent(source, reviewedFile({
            changeType: 'edit, rename',
            path: '$/ExampleProject/src/New.cs',
            basePath: '$/ExampleProject/src/Old.cs',
        }));

        expect(source.requests.filter((request) => request.version.versionType === 'Changeset')[0].path)
            .toBe('$/ExampleProject/src/Old.cs');
    });

    it('does not look for a base version of an added file', async () => {
        const source = contentSource();

        const content = await loadFileContent(
            source, reviewedFile({ changeType: 'add', baseVersion: undefined }));

        expect(source.requests.map((request) => request.version.versionType)).toEqual(['Shelveset']);
        expect(content.baseText).toBe('');
    });

    it('does not look for a reviewed version of a deleted file', async () => {
        const source = contentSource({ 'Changeset:$/ExampleProject/src/Sample.cs': 'gone\n' });

        const content = await loadFileContent(source, reviewedFile({ changeType: 'delete' }));

        expect(source.requests.map((request) => request.version.versionType)).toEqual(['Changeset']);
        expect(content.baseText).toBe('gone\n');
        expect(content.reviewedText).toBe('');
    });

    it('records a failure on one side and still returns the other', async () => {
        // A shelveset deleted since the review, or a base version behind a permission the reader
        // lacks, should cost the diff and nothing else -- the comments are the point of the tab.
        const source = contentSource({
            'Changeset:$/ExampleProject/src/Sample.cs': new Error('TF14021: not found'),
            'Shelveset:$/ExampleProject/src/Sample.cs': 'new\n',
        });

        const content = await loadFileContent(source, reviewedFile());

        expect(content.reviewedText).toBe('new\n');
        expect(content.baseText).toBe('');
        expect(content.note).toContain('TF14021');
        expect(content.note).toContain('base version');
    });

    it('flags binary content so no one tries to diff it line by line', async () => {
        const source = contentSource({
            'Changeset:$/ExampleProject/src/Sample.cs': '',
            'Shelveset:$/ExampleProject/src/Sample.cs': `PNG${NUL}${NUL}${NUL}`,
        });

        const content = await loadFileContent(source, reviewedFile());

        expect(content.isBinary).toBe(true);
    });
});
