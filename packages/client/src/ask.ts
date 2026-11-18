// In-app replacements for window.prompt and window.confirm. Electron does not
// implement window.prompt (it returns nothing), so every question the client asks
// goes through these. They are plain DOM so commands and node views can use them.

interface AskOptions {
  /** The text field's initial value; omit for a yes/no question. */
  value?: string;
  ok?: string;
  danger?: boolean;
}

function open(message: string, opts: AskOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const form = document.createElement('form');
    form.className = 'modal';
    form.setAttribute('role', 'dialog');
    form.setAttribute('aria-modal', 'true');
    form.dataset.testid = 'ask';

    const label = document.createElement('label');
    label.className = 'field';
    const text = document.createElement('span');
    text.className = 'ask-message';
    text.textContent = message;
    label.append(text);
    let input: HTMLInputElement | null = null;
    if (opts.value !== undefined) {
      input = document.createElement('input');
      input.value = opts.value;
      input.spellcheck = false;
      label.append(input);
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = opts.danger ? 'primary danger' : 'primary';
    ok.textContent = opts.ok ?? 'OK';
    actions.append(cancel, ok);
    form.append(label, actions);
    backdrop.append(form);

    const close = (result: string | null) => {
      backdrop.remove();
      previous?.focus?.();
      resolve(result);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      close(input ? input.value : '');
    });
    cancel.addEventListener('click', () => close(null));
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close(null);
    });
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      }
    });

    document.body.append(backdrop);
    if (input) {
      input.focus();
      // Select the file name without its extension, as file managers do.
      const dot = input.value.lastIndexOf('.');
      const slash = input.value.lastIndexOf('/');
      input.setSelectionRange(slash + 1, dot > slash + 1 ? dot : input.value.length);
    } else {
      ok.focus();
    }
  });
}

/** Ask for a line of text. Resolves to null if cancelled. */
export function askText(message: string, value = '', ok?: string): Promise<string | null> {
  return open(message, { value, ok });
}

/** Ask a yes/no question. */
export async function askConfirm(message: string, ok = 'OK', danger = false): Promise<boolean> {
  return (await open(message, { ok, danger })) !== null;
}
