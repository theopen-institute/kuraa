# 0129 · A comment's mark is a bubble, in its maker's colour

From feedback: the 💬 beside each comment in the right margin
([0082](0082-annotations.md)) was not good: an emoji, drawn differently on each platform, small,
and in colours of its own that had nothing to do with the page or with who wrote the comment.

Now a comment's mark is a speech bubble drawn as line art, larger, in the colour of the person who
made the comment.

- **A margin mark may be an icon.** `MarginItem` gains `icon?: FileIcon`: strokes in a 16×16 box,
  as SVG path data, as a file's icon is ([0023](0023-file-icons.md)). The core draws it as it draws
  every icon (thin strokes, no fill) at 20px in a 26×22 mark, in the item's `color`, or the muted
  colour where it has none; faintly filled while `active`. Its `label` stays, for a core that does
  not draw icons, and its `title` is still what is said to screen readers. An optional field, so
  `FEATURE_API_VERSION` stays 2. Tags (`kind: 'tag'`) do not draw an icon.
- **The colour is the commenter's cursor colour** (Settings › You). A new comment, reply or coding
  keeps it in its creator, as `"creator": {…, "color": "#rrggbb"}`, beside the name, and as the name
  is, as it was when it was made. Your own comments are drawn in your colour as it is now; others'
  in the colour their annotation kept; comments from before this, by others, in the muted colour.
  A colour that is not `#rrggbb` is not read.
