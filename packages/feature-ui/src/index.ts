// What components draw with, so that every one looks as the app does (0091):
// a file's icon, drawn as the core draws it (0023), framework-free here and as a
// Vue component (`@kuraa/feature-ui/FileIcon.vue`), used by the client and by
// components alike; and the page's look a component may rely on, said here, as
// it is part of the contract.
//
// The look a component may rely on (the client's style.css defines it):
//
//   Colours and fonts, as CSS variables: --bg, --surface, --panel, --text,
//   --muted, --border, --selected, --accent, --accent-soft, --warn, --warn-soft,
//   --code-bg; --font, --serif, --mono. Each has a dark-mode value.
//
//   Classes:
//     .pane, .pane-right        a pane beside the document, scrolling (a side panel is drawn in one)
//     .pane-header              a pane's heading row, sticky at its top
//     .pane-header-actions      small buttons at the heading's right
//     .muted, .pad, .empty      quieter text; the usual padding; a quiet line where there is nothing
//     .banner (.warn, .info)    a line across a pane saying something
//     .error-details            the details of an error, folded
//     .field                    a label above an input or select
//     .file-icon                a file's icon (as drawn here)
//     .dot, .sr-only            a small round light; text only screen readers read
//
// Anything else a component draws is its own to style, in its own package (the
// sidebar's header, the file tree's rows): the client keeps no component's look
// but these.
import type { FileIcon } from '@kuraa/kernel';

const SVG = 'http://www.w3.org/2000/svg';

/** A file's icon as an element: thin strokes in the text's colour, no fill; without one, a small dot. */
export function fileIconElement(icon?: FileIcon, doc: Document = document): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'file-icon');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (icon) {
    for (const d of icon.paths) {
      const path = doc.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
  } else {
    const dot = doc.createElementNS(SVG, 'circle');
    dot.setAttribute('cx', '8');
    dot.setAttribute('cy', '8');
    dot.setAttribute('r', '1.25');
    dot.setAttribute('class', 'file-icon-dot');
    svg.append(dot);
  }
  return svg;
}
