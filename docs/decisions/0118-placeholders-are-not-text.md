# 0118 · Placeholders are not text

A tester asked:

> "I have speechify AI that just reads what's on my screen. The placeholder "start writing..."
> triggers it and my AI attempts to rephrase it to make it more grammatically correct. Third party
> programs should see that as placeholder, not normal text."

"Start writing…" in an empty document, and "Title" in an empty title, are drawn by CSS (`::before`
with `content: attr(data-placeholder)`); they were never in the document. But Chromium (the
desktop app's Electron) gives the system's accessibility interface text drawn that way as text on
the page, so screen readers and apps that read the screen took the words for something written.

- **The drawn words are hidden from them**: `content: attr(data-placeholder) / ''`, CSS's
  alternative text for generated content, empty. The line before it, without the alternative text,
  is the fallback for a browser that does not read it.
- **The document's editor has `aria-placeholder="Start writing…"`** while the placeholder shows
  (a ProseMirror `attributes` prop of the placeholder plugin), which Chromium hands macOS as the
  field's placeholder, as for a native text field. The line drawn below the header in a document
  with nothing else is `aria-hidden`: a click target, nothing to read.
- **The title keeps its label**, `aria-label="Title"`, as before.

An app that reads the screen by recognizing the pixels still sees the words; nothing in the page
can change that.
