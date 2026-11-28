// Getting images ready to add (0108), for the dialog that adds them
// (ImagesDialog.vue): what each is, how large it is, the details it carries,
// and smaller sizes to choose from, each with how large it would be as kept.
//
// A size's bytes are made here exactly as they are kept: its details removed by
// the kernel's cleanImage, as the host removes them again (finding nothing
// more). The image as it is keeps its file (pixels, colour profile, orientation,
// animation); a smaller size is drawn again in a canvas from the decoded
// picture, turned the right way up, in the same format, and so carries nothing
// but its pixels (in sRGB: a canvas keeps no colour profile).
import { cleanImage, IMAGE_MIME, MAX_IMAGE_BYTES, sniffImage, type ImageDetail, type ImageType } from '@kuraa/kernel';

/** The longest sides offered, largest first: enough for a screen, a page, a column. */
export const SMALLER_SIDES = [2560, 1600, 1024] as const;
/** The largest file that may be chosen at all (to keep, or make smaller): decoding one larger takes too much memory. */
export const MAX_SOURCE_BYTES = 200 * 1024 * 1024;
/** JPEG and WebP made smaller: their quality (0–1). */
const QUALITY = 0.88;

export interface SizeChoice {
  /** The longest side it is made to; 0 for the image at its own size. */
  longest: number;
  width: number;
  height: number;
  /** The file as kept; null while it is made, or if it could not be. */
  file: Blob | null;
  /** How large the file is as kept; null while it is made. */
  size: number | null;
  /** It could not be made (the browser cannot write the format), or is not smaller: not offered. */
  dropped: boolean;
}

export interface ImageCandidate {
  original: File;
  name: string;
  alt: string;
  type: ImageType | null;
  /** Its size as shown (turned the right way up); 0 where not known (an SVG with no size of its own). */
  width: number;
  height: number;
  /** An address in this page to show it at; null if it cannot be shown. */
  preview: string | null;
  removed: ImageDetail[];
  /** Its file could not be read as it is: it is saved again from its picture. */
  resaved: boolean;
  /** Kept at its own size only (GIF, SVG). */
  asIs: boolean;
  /** Its own size first, then smaller ones. */
  choices: SizeChoice[];
  /** The longest side chosen (0: its own size); -1 until one can be. */
  chosen: number;
  /** Why it cannot be added, if it cannot (a key of S.images). */
  error: 'notImage' | 'unreadable' | 'tooLarge' | 'sourceTooLarge' | null;
  /** Still being read. */
  reading: boolean;
}

export function candidate(original: File, name: string, alt: string): ImageCandidate {
  return { original, name, alt, type: null, width: 0, height: 0, preview: null, removed: [], resaved: false, asIs: false, choices: [], chosen: -1, error: null, reading: true };
}

/** The size choice chosen, if it is ready. */
export function chosenChoice(c: ImageCandidate): SizeChoice | null {
  return c.choices.find((x) => x.longest === c.chosen && x.file) ?? null;
}

/**
 * Read a candidate and make its choices, changing it as it goes (it is the
 * dialog's reactive object): its own size first, then each smaller one in turn.
 */
export async function prepare(c: ImageCandidate, isClosed: () => boolean): Promise<void> {
  try {
    await read(c, isClosed);
  } finally {
    c.reading = false;
  }
}

async function read(c: ImageCandidate, isClosed: () => boolean) {
  if (c.original.size > MAX_SOURCE_BYTES) {
    c.error = 'sourceTooLarge';
    return;
  }
  const bytes = new Uint8Array(await c.original.arrayBuffer());
  const type = sniffImage(bytes);
  c.type = type;
  if (!type) {
    c.error = 'notImage';
    return;
  }
  c.preview = URL.createObjectURL(new Blob([bytes], { type: IMAGE_MIME[type] }));
  const clean = cleanImage(bytes);
  if (clean) c.removed = clean.removed;
  c.asIs = type === 'gif' || type === 'svg';

  if (type === 'svg') {
    const size = await naturalSize(c.preview);
    c.width = size.width;
    c.height = size.height;
    if (!clean) {
      c.error = 'unreadable';
      return;
    }
    own(c, clean.bytes, type);
    return;
  }

  const picture = await createImageBitmap(new Blob([bytes], { type: IMAGE_MIME[type] }), { imageOrientation: 'from-image' }).catch(() => null);
  if (picture) {
    c.width = picture.width;
    c.height = picture.height;
  }
  try {
    if (clean) own(c, clean.bytes, type);
    else if (picture && !c.asIs) {
      // A file that could not be read as it is, but shows: saved again from its picture.
      c.resaved = true;
      const made = await draw(picture, picture.width, picture.height, type);
      if (!made) {
        c.error = 'unreadable';
        return;
      }
      own(c, made, type);
    } else {
      c.error = 'unreadable';
      return;
    }
    if (!picture || c.asIs) return;
    const longest = Math.max(picture.width, picture.height);
    const smaller = SMALLER_SIDES.filter((side) => side < longest).map((side): SizeChoice => {
      const scale = side / longest;
      return { longest: side, width: Math.max(1, Math.round(picture.width * scale)), height: Math.max(1, Math.round(picture.height * scale)), file: null, size: null, dropped: false };
    });
    c.choices.push(...smaller);
    for (const choice of c.choices.slice(1)) {
      if (isClosed()) return;
      const made = await draw(picture, choice.width, choice.height, type);
      // Reactive: change it through the candidate's own array.
      const x = c.choices.find((y) => y.longest === choice.longest)!;
      const full = c.choices[0]!.size ?? Infinity;
      if (!made || made.length >= full) x.dropped = true;
      else {
        x.file = new Blob([made], { type: IMAGE_MIME[type] });
        x.size = made.length;
      }
      if (c.chosen === -1 && x.size !== null && x.size <= MAX_IMAGE_BYTES) c.chosen = x.longest;
    }
    c.choices = c.choices.filter((x) => !x.dropped);
    if (c.chosen === -1) c.error = 'tooLarge';
  } finally {
    picture?.close();
  }
}

/** Its own size as the first choice: chosen, if it is not too large to keep. */
function own(c: ImageCandidate, bytes: Uint8Array<ArrayBuffer>, type: ImageType) {
  c.choices.push({ longest: 0, width: c.width, height: c.height, file: new Blob([bytes], { type: IMAGE_MIME[type] }), size: bytes.length, dropped: false });
  if (bytes.length <= MAX_IMAGE_BYTES) c.chosen = 0;
  else if (c.asIs) c.error = 'tooLarge';
}

/** The picture drawn at a size, in its format, with its details removed; null if the browser cannot write the format. */
async function draw(picture: ImageBitmap, width: number, height: number, type: ImageType): Promise<Uint8Array<ArrayBuffer> | null> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(picture, 0, 0, width, height);
  const mime = IMAGE_MIME[type];
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, type === 'png' ? undefined : QUALITY));
  canvas.width = canvas.height = 0;
  if (!blob || blob.type !== mime) return null;
  return cleanImage(new Uint8Array(await blob.arrayBuffer()))?.bytes ?? null;
}

/** An image's size as the page shows it (an SVG's from its width and height, or none). */
function naturalSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}
