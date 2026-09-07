/**
 * The box you type a comment into.
 *
 * One rule drives the whole design: **never lose what someone typed.** A review comment can be
 * several careful sentences, and the write can fail for reasons that have nothing to do with the
 * text -- a lapsed token, a lost connection, a permission. So a failure leaves the text exactly where
 * it was, with the reason above it and the button ready to try again. The form is removed only after
 * the server has confirmed the write.
 */

import { className, element } from './dom';

export interface CommentFormOptions {
    readonly placeholder: string;
    readonly submitLabel: string;
    /** Resolves once the comment is safely stored. Rejecting leaves the form and its text in place. */
    readonly onSubmit: (content: string) => Promise<void>;
    readonly onCancel: () => void;
}

export function renderCommentForm(options: CommentFormOptions): HTMLElement {
    const form = element('div', className('comment-form'));

    const status = element('p', className('comment-form-error'));
    status.hidden = true;
    form.appendChild(status);

    const input = element('textarea', className('comment-input'));
    input.rows = 3;
    input.placeholder = options.placeholder;
    input.setAttribute('aria-label', options.placeholder);
    form.appendChild(input);

    const actions = element('div', className('comment-form-actions'));
    const submit = element('button', className('button'), options.submitLabel);
    submit.type = 'button';
    const cancel = element('button', className('button'), 'Cancel');
    cancel.type = 'button';
    actions.appendChild(submit);
    actions.appendChild(cancel);
    form.appendChild(actions);

    const setBusy = (busy: boolean): void => {
        submit.disabled = busy;
        cancel.disabled = busy;
        input.readOnly = busy;
        submit.textContent = busy ? 'Posting\u2026' : options.submitLabel;
    };

    submit.addEventListener('click', () => {
        const content = input.value.trim();
        if (content === '') {
            status.hidden = false;
            status.textContent = 'Type something first.';
            input.focus();
            return;
        }

        status.hidden = true;
        setBusy(true);

        options.onSubmit(content)
            .catch((error: unknown) => {
                // The text stays in the textarea. Whatever went wrong, retyping it is not the fix.
                setBusy(false);
                status.hidden = false;
                status.textContent = `That comment was not posted: ${
                    error instanceof Error ? error.message : String(error)}`;
            });
    });

    cancel.addEventListener('click', () => {
        options.onCancel();
    });

    // Focused on creation so the form is usable straight from the click that opened it.
    window.setTimeout(() => { input.focus(); }, 0);

    return form;
}
