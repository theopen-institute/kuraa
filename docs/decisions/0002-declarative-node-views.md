# 0002 · Declarative node views

The spec's `DocumentType.editor` lists `plugins`, `nodeViews` and `commands`, but also says format
packages import only `kernel` and `prosemirror-model` and run headless. Node views need
`prosemirror-view` and CodeMirror, so they cannot live in a format package.

Resolution: `editor.nodeViews` maps node names to a `NodeViewHint` (kernel type), for example
`{ kind: 'code', language: 'r', header: { attr: 'header', prefix: '{', suffix: '}' } }`. The client
implements each hint kind once (`code` is a CodeMirror view, `atom` an editable chip). R Markdown's
code chunks are a `code` hint with a header; no client code mentions R Markdown.

When third-party types need behaviour that hints cannot describe, the plugin phase can add a
trusted, client-side contribution entry point beside the headless one.

*Since 0012:* hints still describe how to show nodes, but a format may also draw its own node views
in its editor module (the Pandoc editor draws footnotes); the editor module, not the core, may use
ProseMirror's view code.
