/**
 * The states the tab shows instead of a review: a failure, a work item that is not a code review,
 * and the request for a personal access token.
 *
 * Kept apart from the reviewer UI because these have to work when nothing else does -- in particular
 * `renderError` is the last thing the entry point falls back to, so it depends on as little as
 * possible.
 */

import { className, element, resetRoot } from './dom';

const TITLE = 'TFVC code review comments';

export interface PersonalAccessTokenPromptOptions {
    /** Used to link the user straight to the page where tokens are created. */
    readonly collectionUri: string;
    /** Shown above the form, for example after a token has been rejected. */
    readonly message?: string;
    readonly onSave: (personalAccessToken: string) => void;
}

/**
 * Asks the user for a personal access token.
 *
 * Azure DevOps Server refuses a delegated extension token at the discussion API while accepting a
 * personal access token for the identical request, so on a stock server the user's own token is the
 * only credential this tab can use. That is a server limitation, not a design choice, and the
 * wording says so: being asked for a credential by an extension is unusual enough to deserve an
 * explanation. See docs/installing.md for the alternative, which is a server-side change that lets
 * the tab authenticate as the signed-in user with no token at all.
 */
export function renderPersonalAccessTokenPrompt(
    host: HTMLElement,
    options: PersonalAccessTokenPromptOptions): void {
    const root = resetRoot(host);
    root.appendChild(element('h1', className('title'), TITLE));

    if (options.message) {
        root.appendChild(element('p', className('warning'), options.message));
    }

    root.appendChild(element(
        'p',
        undefined,
        'This tab needs a personal access token to read code review comments. Azure DevOps Server '
        + 'does not let an extension read them with its own credentials, so it has to use yours.'));

    const list = element('ul');
    const steps = [
        'Create a token from your user settings, under Personal access tokens.',
        'Give it read access to Work Items and Code, and nothing else.',
        'Set an expiry you are comfortable with; you will be asked again when it lapses.',
    ];
    for (const step of steps) {
        list.appendChild(element('li', undefined, step));
    }
    root.appendChild(list);

    const link = element('a', undefined, 'Open personal access tokens');
    link.href = `${options.collectionUri.replace(/\/+$/, '')}/_usersSettings/tokens`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    root.appendChild(link);

    const form = element('div', className('section'));

    const input = element('input', className('input'));
    // A token is a credential: never render it in a readable field, and never place it in the DOM
    // anywhere it could be recovered from markup.
    input.type = 'password';
    input.autocomplete = 'off';
    input.placeholder = 'Paste your personal access token';
    input.setAttribute('aria-label', 'Personal access token');
    form.appendChild(input);

    const save = element('button', className('button'), 'Save');
    save.type = 'button';
    save.addEventListener('click', () => {
        const value = input.value.trim();
        if (!value) {
            return;
        }
        input.value = '';
        options.onSave(value);
    });
    form.appendChild(save);

    root.appendChild(form);
    root.appendChild(element(
        'p',
        className('empty'),
        'The token is stored against your own account and is not visible to anyone else using this '
        + 'extension.'));
}

/** Renders the empty state shown on a work item that is not a code review request. */
export function renderNotACodeReview(host: HTMLElement, workItemType: string): void {
    const root = resetRoot(host);
    root.appendChild(element('h1', className('title'), TITLE));
    root.appendChild(element(
        'p',
        className('empty'),
        workItemType
            ? `This tab shows TFVC code review comments, and this work item is a '${workItemType}'.`
            : 'This tab shows TFVC code review comments for a Code Review Request work item.'));
}

/**
 * Renders a failure.
 *
 * Shown in place of the content rather than thrown onward, so that a broken load degrades to a
 * readable message instead of an empty tab. Azure DevOps hosts every contribution in its own frame,
 * so whatever went wrong here cannot reach the rest of the work item form; uninstalling or disabling
 * the extension removes it entirely.
 */
export function renderError(host: HTMLElement, error: unknown, details?: string): void {
    const root = resetRoot(host);
    root.appendChild(element('h1', className('title'), TITLE));

    const panel = element('div', className('error'));
    panel.appendChild(element('p', undefined, 'This tab could not load the code review comments.'));

    const message = error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    panel.appendChild(element('pre', className('preformatted'), message));

    if (details) {
        panel.appendChild(element('h3', className('subheading'), 'Details'));
        panel.appendChild(element('pre', className('preformatted'), details));
    }

    root.appendChild(panel);
}
