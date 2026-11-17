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

export interface FileTypeChoice {
  id: string;
  label: string;
  /** The usual extension for new files of this type, with the dot. */
  extension: string;
  /** Heading the type is listed under. */
  group: string;
}

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
};

/**
 * Ask for a new file's path and type. Choosing a type sets the name's
 * extension; typing a name with a known extension chooses its type. A name
 * without an extension gets the chosen type's. Resolves to the path, or null.
 */
export function askNewFile(opts: {
  folder: string;
  types: FileTypeChoice[];
  defaultType: string;
  /** The type a path would open as, if any. */
  typeOf(path: string): string | null;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const byId = new Map(opts.types.map((t) => [t.id, t]));
    const first = byId.get(opts.defaultType) ?? opts.types[0];

    const backdrop = Object.assign(document.createElement('div'), { className: 'modal-backdrop' });
    const form = Object.assign(document.createElement('form'), { className: 'modal' });
    form.setAttribute('role', 'dialog');
    form.setAttribute('aria-modal', 'true');
    form.dataset.testid = 'ask';
    form.append(Object.assign(document.createElement('h2'), { textContent: 'New file' }));

    const typeField = Object.assign(document.createElement('label'), { className: 'field' });
    typeField.append(Object.assign(document.createElement('span'), { textContent: 'File type' }));
    const select = document.createElement('select');
    select.name = 'type';
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const t of opts.types) {
      let group = groups.get(t.group);
      if (!group) {
        group = Object.assign(document.createElement('optgroup'), { label: t.group });
        groups.set(t.group, group);
        select.append(group);
      }
      group.append(new Option(`${t.label} (${t.extension})`, t.id));
    }
    if (first) select.value = first.id;
    typeField.append(select);

    const nameField = Object.assign(document.createElement('label'), { className: 'field' });
    nameField.append(Object.assign(document.createElement('span'), { textContent: 'Name' }));
    const input = document.createElement('input');
    input.name = 'path';
    input.spellcheck = false;
    input.value = `${opts.folder}untitled${first?.extension ?? ''}`;
    nameField.append(input);

    const actions = Object.assign(document.createElement('div'), { className: 'modal-actions' });
    const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Cancel' });
    const ok = Object.assign(document.createElement('button'), { type: 'submit', className: 'primary', textContent: 'Create' });
    actions.append(cancel, ok);
    form.append(typeField, nameField, actions);
    backdrop.append(form);

    let chosen = select.value;
    select.addEventListener('change', () => {
      const from = byId.get(chosen);
      const to = byId.get(select.value);
      chosen = select.value;
      if (!to) return;
      const ext = extensionOf(input.value);
      if (ext) input.value = input.value.slice(0, -ext.length) + to.extension;
      else if (from && input.value.endsWith('untitled')) input.value += to.extension;
    });
    input.addEventListener('input', () => {
      const id = opts.typeOf(input.value);
      if (id && byId.has(id) && id !== select.value) select.value = chosen = id;
    });

    const close = (result: string | null) => {
      backdrop.remove();
      previous?.focus?.();
      resolve(result);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      let path = input.value.trim();
      if (!path) return;
      if (!extensionOf(path) && !opts.typeOf(path)) path += byId.get(select.value)?.extension ?? '';
      close(path);
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
    input.focus();
    const name = input.value.lastIndexOf('/') + 1;
    input.setSelectionRange(name, name + 'untitled'.length);
  });
}
