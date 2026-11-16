// Read-only views: serialized source in CodeMirror, and a document rendered by its type.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentType, ParsedDocument } from '@kuraa/kernel';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState as PMState } from 'prosemirror-state';
import { EditorView as PMView } from 'prosemirror-view';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { highlighter } from './languages.js';
import { markdown } from '@codemirror/lang-markdown';
import type { HostApi } from './api.js';
import { buildNodeViews } from './nodeviews.js';
import { highlightPlugin } from './lines.js';

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

/** The text the host would write for `doc`: serialized against the file as it is on disk now. */
export function SourceView({ api, path, type, doc }: { api: HostApi; path: string; type: DocumentType; doc: PMNode }) {
  const [previous, setPrevious] = useState<ParsedDocument | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    api.fileText(path).then(
      (t) => !cancelled && setPrevious(type.parse(t)),
      () => !cancelled && setPrevious(undefined),
    );
    return () => { cancelled = true; };
  }, [api, path, type]);
  const text = useMemo(() => type.serialize(doc, previous), [doc, previous, type]);
  return <ReadOnlyCode text={text} testId="source" />;
}

/** A document rendered by its type, not editable. */
export function ReadOnlyDoc({ text, type }: { text: string; type: DocumentType }) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const layout = type.editor?.layout;
    const view = new PMView(mount.current!, {
      state: PMState.create({ doc: type.parse(text).doc, plugins: layout ? [highlightPlugin(layout)] : [] }),
      editable: () => false,
      nodeViews: buildNodeViews(type.editor?.nodeViews ?? {}),
      attributes: { class: layout ? 'lines-doc' : 'prose' },
    });
    return () => view.destroy();
  }, [text, type]);
  return <div className={type.editor?.layout ? 'editor-mount editor-mount-lines' : 'editor-mount'} ref={mount} />;
}
