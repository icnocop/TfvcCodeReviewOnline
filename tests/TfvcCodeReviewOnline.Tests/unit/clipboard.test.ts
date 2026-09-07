import { afterEach, describe, expect, it } from 'vitest';

import { copyText } from '../../../src/TfvcCodeReviewOnline.Web/ts/view/clipboard';

/**
 * jsdom implements neither `execCommand` nor the Clipboard API, which is convenient: the absent
 * `execCommand` is exactly the state of a browser that refuses the copy, and standing one up is how
 * the successful path is exercised.
 */
interface Stub {
    readonly copied: string[];
    restore: () => void;
}

function stubExecCommand(result: boolean): Stub {
    const copied: string[] = [];

    // The textarea the copy is made from is still in the document while the command runs.
    Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: (command: string) => {
            if (command === 'copy') {
                copied.push(document.querySelector('textarea')?.value ?? '');
            }
            return result;
        },
        writable: true,
    });

    return {
        copied,
        restore: () => {
            delete (document as Partial<Document>).execCommand;
        },
    };
}

let stub: Stub | undefined;

afterEach(() => {
    stub?.restore();
    stub = undefined;
});

describe('copyText', () => {
    it('copies through a selection, which works without a secure context', () => {
        // Which is the case that matters: an on-premises server is usually reached over plain HTTP,
        // where navigator.clipboard does not exist at all.
        stub = stubExecCommand(true);

        expect(copyText('$/ExampleProject/src/Sample.cs')).toBe(true);
        expect(stub.copied).toEqual(['$/ExampleProject/src/Sample.cs']);
    });

    it('leaves nothing behind in the document', () => {
        stub = stubExecCommand(true);

        copyText('$/ExampleProject/src/Sample.cs');

        expect(document.querySelector('textarea')).toBeNull();
    });

    it('says so when there is no way to copy at all', () => {
        // No execCommand and no Clipboard API. The caller can then say nothing happened rather than
        // claiming a copy that never took place.
        expect(copyText('anything')).toBe(false);
    });

    it('reports failure rather than throwing when the command is refused', () => {
        stub = stubExecCommand(false);

        expect(copyText('anything')).toBe(false);
    });
});
