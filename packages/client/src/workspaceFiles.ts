// The workspace's files as a document's editor module reaches them
// (editor-kit's WorkspaceFiles): its bibliography's text, its images, images
// pasted or dropped into it, and who made a commit. Everything goes through the
// host, with the token in a header, never in an address: images are fetched and
// shown from addresses made for this page (object URLs), let go when it closes.
import type { WorkspaceFiles } from '@kuraa/editor-kit';
import { ApiError, type HostApi } from './api.js';

const SHOWN = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/bmp']);

export interface DisposableFiles extends WorkspaceFiles {
  /** Let go of the images' addresses. */
  dispose(): void;
}

export function workspaceFiles(api: HostApi, doc: string, by: () => { name: string; email: string }): DisposableFiles {
  const urls = new Map<string, Promise<string | null>>();
  const commits = new Map<string, Promise<{ author: string; date: string } | null>>();
  let disposed = false;
  const missing = (e: unknown) => {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400 || e.status === 403 || e.status === 415)) return null;
    throw e;
  };
  return {
    text: (path) => api.fileText(path).catch(missing),
    imageUrl(path) {
      let url = urls.get(path);
      if (!url) {
        url = api.rawFile(path).then((blob) => {
          // Only images are shown, and an SVG only ever as an image (never in the page).
          if (disposed || !SHOWN.has(blob.type)) return null;
          return URL.createObjectURL(blob);
        }).catch((e: unknown) => {
          urls.delete(path);
          return missing(e);
        });
        urls.set(path, url);
      }
      return url;
    },
    async uploadImage(file, name) {
      const r = await api.uploadImage(doc, name, file, by());
      return r.src;
    },
    commit(hash) {
      let c = commits.get(hash);
      if (!c) {
        c = api.commitInfo(hash).catch(missing);
        commits.set(hash, c);
      }
      return c;
    },
    dispose() {
      disposed = true;
      for (const u of urls.values()) void u.then((x) => x && URL.revokeObjectURL(x), () => undefined);
      urls.clear();
    },
  };
}
