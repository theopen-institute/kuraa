// Read-only views: serialized source in CodeMirror, and a document rendered by its type.
import { useEffect, useMemo, useRef } from 'react';
import type { DocumentType } from '@kuraa/kernel';
import { EditorState as PMState } from 'prosemirror-state';
import { EditorView as PMView } from 'prosemirror-view';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { highlighter } from './languages.js';
import { markdown } from '@codemirror/lang-markdown';
import { buildNodeViews } from './nodeviews.js';
import { highlightPlugin } from './lines.js';
import type { EditorContext, FormatEditor } from '@kuraa/editor-kit';
import { askConfirm, askText } from './ask.js';

/** Plain text in a read-only CodeMirror editor. */
export function ReadOnlyCode({ text, testId }: { text: string; testId?: string }) {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const content = useMemo(() => new Compartment(), []);

  useEffect(() => {
    const v = new EditorView({
      parent: mount.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          markdown(),
          syntaxHighlighting(highlighter),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          content.of([]),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // Created once; text changes are applied below.
  }, [content]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== text) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }, [text]);

  return <div className="source-view" ref={mount} data-testid={testId} />;
}

/** A document rendered by its type, not editable. */
export function ReadOnlyDoc({ text, type, path, formatEditor }: { text: string; type: DocumentType; path: string; formatEditor?: FormatEditor }) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const layout = type.editor?.layout;
    const nothing = () => false;
    const ctx: EditorContext = { schema: type.schema, readOnly: true, history: { undo: nothing, redo: nothing }, isRemote: () => false, ui: { askText, askConfirm } };
    const view = new PMView(mount.current!, {
      state: PMState.create({ doc: type.parse(text).doc, plugins: layout ? [highlightPlugin(layout, path)] : (formatEditor?.plugins?.(ctx) ?? []) }),
      editable: () => false,
      nodeViews: { ...buildNodeViews(type.editor?.nodeViews ?? {}), ...(formatEditor?.nodeViews?.(ctx) ?? {}) },
      attributes: { class: layout ? 'lines-doc' : 'prose' },
    });
    return () => view.destroy();
  }, [text, type, path, formatEditor]);
  return <div className={type.editor?.layout ? 'editor-mount editor-mount-lines' : 'editor-mount'} ref={mount} />;
}
