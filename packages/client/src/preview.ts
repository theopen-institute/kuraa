// The rendered page as the Preview panel shows it: in a frame sandboxed without
// scripts (decision 0018: nothing in a document runs in the app), with a policy
// of its own on top of the app's that lets it show itself and nothing more: no
// scripts, no requests, only what is inside the page (images and fonts as data).

export const PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:";

/** A rendered page with the preview's policy first in its head. */
export function previewDocument(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + meta + html.slice(head.index + head[0].length);
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

/** What a rendered file is saved as: the document's file name, with the format's extension. */
export function outputName(path: string, format: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${format}`;
}

/** Hand a file to the browser to save (the desktop app asks where, with a save dialog). */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
