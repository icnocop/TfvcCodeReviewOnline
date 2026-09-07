import { describe, expect, it } from 'vitest';

import type { ReviewedFileContent } from '../../../src/TfvcCodeReviewOnline.Web/ts/clients/tfvcClient';
import {
    buildFileDiff,
    describeFileChange,
} from '../../../src/TfvcCodeReviewOnline.Web/ts/model/fileDiff';
import { reviewedFile } from './support/reviewFixtures';

function content(overrides: Partial<ReviewedFileContent> = {}): ReviewedFileContent {
    return {
        baseText: 'one\ntwo\n',
        reviewedText: 'one\nTWO\n',
        isBinary: false,
        note: undefined,
        ...overrides,
    };
}

describe('buildFileDiff', () => {
    it('diffs the two versions', () => {
        const result = buildFileDiff(content());

        expect(result.lines?.map((line) => line.kind)).toEqual(['context', 'removed', 'added']);
        expect(result.note).toBeUndefined();
    });

    it('refuses to line-diff a binary file and says why', () => {
        const result = buildFileDiff(content({ isBinary: true }));

        expect(result.lines).toBeUndefined();
        expect(result.note).toContain('binary');
    });

    it('explains a change that touched no lines', () => {
        const result = buildFileDiff(content({ baseText: 'same\n', reviewedText: 'same\n' }));

        expect(result.lines?.every((line) => line.kind === 'context')).toBe(true);
    });

    it('explains two empty sides rather than rendering an empty table', () => {
        const result = buildFileDiff(content({ baseText: '', reviewedText: '' }));

        expect(result.lines).toBeUndefined();
        expect(result.note).toContain('no line changes');
    });

    it('keeps a fetch failure visible alongside whatever could be shown', () => {
        // Half a diff plus the reason the other half is missing is more use than either alone.
        const result = buildFileDiff(content({ baseText: '', note: 'The base version could not be read: 404.' }));

        expect(result.lines?.every((line) => line.kind === 'added')).toBe(true);
        expect(result.note).toBe('The base version could not be read: 404.');
    });

    it('does not claim a file is unchanged when nothing could be fetched', () => {
        const result = buildFileDiff(
            content({ baseText: '', reviewedText: '', note: 'The reviewed version could not be read: 404.' }));

        expect(result.note).toBe('The reviewed version could not be read: 404.');
        expect(result.note).not.toContain('no line changes');
    });
});

describe('describeFileChange', () => {
    it('names an add, a delete, and a rename', () => {
        expect(describeFileChange(reviewedFile({ changeType: 'add' }))).toContain('Added');
        expect(describeFileChange(reviewedFile({ changeType: 'delete' }))).toContain('Deleted');
        expect(describeFileChange(reviewedFile({
            changeType: 'edit, rename',
            path: '$/ExampleProject/src/New.cs',
            basePath: '$/ExampleProject/src/Old.cs',
        }))).toContain('$/ExampleProject/src/Old.cs');
    });

    it('says nothing about an ordinary edit', () => {
        expect(describeFileChange(reviewedFile({ changeType: 'edit' }))).toBe('');
    });
});
