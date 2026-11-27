// What every view of a document builds the same way, live or past: the context
// a format's editor module is handed (decision 0012), the node views (the
// client's, from the type's hints, with the module's over them), and the keys
// for the session's undo and redo.
import type { DocumentType } from '@kuraa/kernel';
import type { EditorContext, EditorUi, FormatEditor } from '@kuraa/editor-kit';
import type { Plugin } from 'prosemirror-state';
import type { NodeViewConstructor } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { askConfirm, askText } from './ask.js';
import { buildNodeViews, type NodeViewContext } from './nodeviews.js';

type History = EditorContext['history'];

const ui = { askText, askConfirm };
const nothing = () => false;

/** The context for a live document (its room's undo and remote check), or a read-only one for a past version. */
export function editorContext(
  type: DocumentType,
  live?: { history: History; isRemote: EditorContext['isRemote']; path?: string; files?: EditorContext['files']; notify?: EditorUi['notify']; spelling?: EditorUi['spelling'] },
): EditorContext {
  return live
    ? { schema: type.schema, readOnly: false, history: live.history, isRemote: live.isRemote, ui: { ...ui, notify: live.notify, ...(live.spelling ? { spelling: live.spelling } : {}) }, path: live.path, files: live.files }
    : { schema: type.schema, readOnly: true, history: { undo: nothing, redo: nothing }, isRemote: () => false, ui };
}

/** The type's node views: the client's from its hints, then the editor module's, which win. */
export function nodeViewsFor(type: DocumentType, ctx: EditorContext, formatEditor?: FormatEditor, nodeCtx?: NodeViewContext): Record<string, NodeViewConstructor> {
  return { ...buildNodeViews(type.editor?.nodeViews ?? {}, nodeCtx), ...(formatEditor?.nodeViews?.(ctx) ?? {}) };
}

/** Undo and redo, as the session does them (not ProseMirror's own history). */
export const historyKeys = (history: History): Plugin => keymap({ 'Mod-z': history.undo, 'Mod-Shift-z': history.redo, 'Mod-y': history.redo });
