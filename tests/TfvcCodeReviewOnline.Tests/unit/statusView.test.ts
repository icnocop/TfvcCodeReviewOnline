import { beforeEach, describe, expect, it } from 'vitest';

import {
    renderError,
    renderNotACodeReview,
    renderPersonalAccessTokenPrompt,
} from '../../../src/TfvcCodeReviewOnline.Web/ts/view/statusView';

let host: HTMLElement;

beforeEach(() => {
    document.body.textContent = '';
    host = document.createElement('div');
    document.body.appendChild(host);
});

describe('renderNotACodeReview', () => {
    it('scopes everything it renders under a single root class', () => {
        // Every CSS rule is scoped under this class. If the root element were ever renamed or
        // omitted, the stylesheet would silently stop applying, so the contract is asserted.
        renderNotACodeReview(host, 'Bug');

        expect(host.children).toHaveLength(1);
        expect(host.children[0].className).toBe('tfvc-code-review-online');
    });

    it('names the work item type it was shown on', () => {
        renderNotACodeReview(host, 'Bug');

        expect(host.textContent).toContain("this work item is a 'Bug'");
    });

    it('renders a generic message when the type is unknown', () => {
        renderNotACodeReview(host, '');

        expect(host.textContent).toContain('Code Review Request');
    });
});

describe('renderError', () => {
    it('shows the error and replaces any previous content', () => {
        renderNotACodeReview(host, 'Bug');
        renderError(host, new Error('Boom'), 'HTTP 500');

        const text = host.textContent ?? '';
        expect(text).toContain('Error: Boom');
        expect(text).toContain('HTTP 500');
        expect(text).not.toContain('Bug');
    });

    it('handles a thrown value that is not an Error', () => {
        renderError(host, 'just a string');

        expect(host.textContent).toContain('just a string');
    });

    it('renders the detail as text, never as markup', () => {
        // A failed response body can contain anything at all, including markup from an error page.
        renderError(host, new Error('Boom'), '<img src=x onerror="alert(1)">');

        expect(host.querySelector('img')).toBeNull();
        expect(host.textContent).toContain('<img src=x onerror="alert(1)">');
    });
});

describe('renderPersonalAccessTokenPrompt', () => {
    it('links to the page where a token is created', () => {
        renderPersonalAccessTokenPrompt(host, {
            collectionUri: 'https://tfs.example.com/DefaultCollection/',
            onSave: () => undefined,
        });

        const link = host.querySelector('a');
        expect(link?.getAttribute('href'))
            .toBe('https://tfs.example.com/DefaultCollection/_usersSettings/tokens');
    });

    it('never renders the token in a readable field', () => {
        // A personal access token is a credential; showing it on screen would be a way to leak it
        // over someone's shoulder or into a screen share.
        renderPersonalAccessTokenPrompt(host, {
            collectionUri: 'https://tfs.example.com/DefaultCollection',
            onSave: () => undefined,
        });

        expect(host.querySelector('input')?.type).toBe('password');
    });

    it('hands the entered token over and clears the field', () => {
        const saved: string[] = [];
        renderPersonalAccessTokenPrompt(host, {
            collectionUri: 'https://tfs.example.com/DefaultCollection',
            onSave: (token) => { saved.push(token); },
        });

        const input = host.querySelector('input') as HTMLInputElement;
        input.value = '  a-token  ';
        (host.querySelector('button') as HTMLButtonElement).click();

        expect(saved).toEqual(['a-token']);
        expect(input.value).toBe('');
    });

    it('ignores an empty field rather than saving nothing', () => {
        const saved: string[] = [];
        renderPersonalAccessTokenPrompt(host, {
            collectionUri: 'https://tfs.example.com/DefaultCollection',
            onSave: (token) => { saved.push(token); },
        });

        (host.querySelector('button') as HTMLButtonElement).click();

        expect(saved).toEqual([]);
    });

    it('shows the reason a previous token was refused', () => {
        renderPersonalAccessTokenPrompt(host, {
            collectionUri: 'https://tfs.example.com/DefaultCollection',
            message: 'That personal access token was rejected.',
            onSave: () => undefined,
        });

        expect(host.textContent).toContain('That personal access token was rejected.');
    });
});
