// Image files' bytes (decision 0106): what kind of image a file is, known by its
// bytes, and the details it carries beyond its picture (where a photo was taken,
// the camera and its serial number, when, who, the software, a thumbnail of the
// uncropped original, images or video appended after it), found and removed.
// What is kept is what the picture needs to look the same: its pixels, its
// colour profile, its orientation and its animation.
//
// It runs on the host (every image it adds is cleaned there) and in the page
// (the dialog that adds images shows exactly what will be kept), so it uses
// neither the DOM nor Node: bytes in, bytes out. Cleaning what is already clean
// changes nothing, so the host cleaning what the page cleaned is the same file.

/** The images that can be added: those every browser shows, and SVG (only ever shown as an image). */
export type ImageType = 'png' | 'jpg' | 'gif' | 'webp' | 'svg';

export const IMAGE_MIME: Record<ImageType, string> = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};

/** The largest image that may be kept in a workspace (after its details are removed and it is made smaller, if it is). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * A file this size or larger is a large one: the dialog that adds images says
 * so, and suggests a smaller size. It is also the size above which devices may
 * one day fetch a file only when it is needed, rather than with its history
 * (0106: partial clones, not built).
 */
export const LARGE_FILE_BYTES = 1024 * 1024;

/** A kind of detail an image file can carry beyond its picture. */
export type ImageDetail = 'location' | 'camera' | 'date' | 'author' | 'description' | 'software' | 'thumbnail' | 'appended' | 'other';

/** The order details are listed in: those people most often do not know are there first. */
export const IMAGE_DETAILS: readonly ImageDetail[] = ['location', 'camera', 'date', 'author', 'description', 'thumbnail', 'appended', 'software', 'other'];

export interface CleanedImage {
  type: ImageType;
  /** The file with only its picture: what is kept. */
  bytes: Uint8Array<ArrayBuffer>;
  /** What was in the file and is not kept, in IMAGE_DETAILS's order. */
  removed: ImageDetail[];
}

/** The kind of image the bytes are, or null. An SVG must at least look like one. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && ascii(b, 0, 6).match(/^GIF8[79]a$/)) return 'gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  // The decoder drops a byte order mark, and trimStart one left.
  const head = utf8(b.subarray(0, 4096)).trimStart();
  if ((head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!--') || head.startsWith('<!DOCTYPE svg')) && /<svg[\s>]/.test(head)) return 'svg';
  return null;
}

/**
 * The image with its details removed; null if it is not an image of a kind
 * listed in ImageType, or its structure could not be read (a damaged file),
 * so what it carries could not be found.
 */
export function cleanImage(bytes: Uint8Array): CleanedImage | null {
  const type = sniffImage(bytes);
  if (!type) return null;
  const removed = new Set<ImageDetail>();
  let out: Uint8Array<ArrayBuffer> | null;
  try {
    out = type === 'jpg' ? cleanJpeg(bytes, removed)
      : type === 'png' ? cleanPng(bytes, removed)
      : type === 'webp' ? cleanWebp(bytes, removed)
      : type === 'gif' ? cleanGif(bytes, removed)
      : cleanSvg(bytes, removed);
  } catch {
    out = null;
  }
  if (!out) return null;
  return { type, bytes: out, removed: IMAGE_DETAILS.filter((d) => removed.has(d)) };
}

// ---------------------------------------------------------------------------
// Bytes

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = '';
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

function utf8(b: Uint8Array): string {
  return new TextDecoder('utf-8').decode(b);
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const startsWith = (b: Uint8Array, s: string, at = 0) => ascii(b, at, s.length) === s;
/** Whether anything but padding (zeros, 0xFF) follows a file's end. */
const hasData = (b: Uint8Array) => b.some((x) => x !== 0 && x !== 0xff);

// ---------------------------------------------------------------------------
// EXIF (a TIFF structure), in JPEG, PNG and WebP: what it says, and the one
// thing kept from it, the orientation (else a phone's photo shows on its side).

interface Exif {
  orientation: number;
}

function readExif(t: Uint8Array, removed: Set<ImageDetail>): Exif {
  const found: Exif = { orientation: 1 };
  if (t.length < 8) return found;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) {
    removed.add('other');
    return found;
  }
  const u16 = (o: number) => (o + 2 <= t.length ? (le ? t[o]! | (t[o + 1]! << 8) : (t[o]! << 8) | t[o + 1]!) : -1);
  const u32 = (o: number) => (o + 4 <= t.length ? (le ? u32le(t, o) : u32be(t, o)) : -1);
  if (u16(2) !== 42) return found;
  const seen = new Set<number>();
  const MAIN: Record<number, ImageDetail> = {
    0x010e: 'description', 0x010f: 'camera', 0x0110: 'camera', 0x0131: 'software', 0x0132: 'date', 0x013b: 'author',
    0x8298: 'author', 0x9c9b: 'description', 0x9c9c: 'description', 0x9c9d: 'author', 0x9c9e: 'description', 0x9c9f: 'description',
    0x02bc: 'other', 0x83bb: 'other', 0xc4a5: 'other',
  };
  const EXIF: Record<number, ImageDetail> = {
    0x9003: 'date', 0x9004: 'date', 0x9010: 'date', 0x9011: 'date', 0x9012: 'date', 0x9290: 'date', 0x9291: 'date', 0x9292: 'date',
    0x927c: 'camera', 0x829a: 'camera', 0x829d: 'camera', 0x8827: 'camera', 0x920a: 'camera', 0x9209: 'camera', 0x9207: 'camera',
    0xa430: 'camera', 0xa431: 'camera', 0xa432: 'camera', 0xa433: 'camera', 0xa434: 'camera', 0xa435: 'camera',
    0x9286: 'description', 0xa420: 'other',
  };
  const ifd = (off: number, kind: 'main' | 'exif' | 'gps'): number => {
    if (off < 8 || off + 2 > t.length || seen.has(off)) return 0;
    seen.add(off);
    const n = u16(off);
    for (let k = 0; k < n && k < 1000; k++) {
      const e = off + 2 + 12 * k;
      if (e + 12 > t.length) break;
      const tag = u16(e);
      if (kind === 'gps') {
        if (tag !== 0) removed.add('location');
        continue;
      }
      const detail = (kind === 'main' ? MAIN : EXIF)[tag];
      if (detail) removed.add(detail);
      if (kind === 'main' && tag === 0x0112) {
        const o = u16(e + 8);
        if (o >= 1 && o <= 8) found.orientation = o;
      }
      if (kind === 'main' && tag === 0x8769) ifd(u32(e + 8), 'exif');
      if (kind === 'main' && tag === 0x8825) ifd(u32(e + 8), 'gps');
    }
    return n >= 0 ? u32(off + 2 + 12 * n) : 0;
  };
  // The first directory's next is the second, which holds a thumbnail.
  if (ifd(u32(4), 'main') > 0) removed.add('thumbnail');
  return found;
}

/** An EXIF structure saying only the orientation (big-endian TIFF: header, one entry, no next directory). */
function exifOfOrientation(o: number): Uint8Array {
  return new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0]);
}

/** What an XMP packet says, by the names it uses. */
function readXmp(text: string, removed: Set<ImageDetail>) {
  const before = removed.size;
  if (/exif:GPS|Iptc4xmpCore:Location|photoshop:City|photoshop:State|photoshop:Country|Iptc4xmpExt:LocationShown/.test(text)) removed.add('location');
  if (/tiff:Make|tiff:Model|aux:SerialNumber|aux:Lens|exifEX:BodySerialNumber|exifEX:Lens|exif:FNumber|exif:ExposureTime/.test(text)) removed.add('camera');
  if (/xmp:CreateDate|xmp:ModifyDate|xmp:MetadataDate|photoshop:DateCreated|exif:DateTimeOriginal/.test(text)) removed.add('date');
  if (/dc:creator|dc:rights|photoshop:AuthorsPosition|xmpRights:/.test(text)) removed.add('author');
  if (/xmp:CreatorTool|xmpMM:History|stEvt:softwareAgent|photoshop:History/.test(text)) removed.add('software');
  if (/dc:description|dc:title|dc:subject|exif:UserComment|photoshop:Headline/.test(text)) removed.add('description');
  if (removed.size === before) removed.add('other');
}

// ---------------------------------------------------------------------------
// JPEG: markers, each segment kept, dropped or (EXIF) replaced; nothing after
// the image's end (a second image, a motion photo's video).

const JPEG_SOS = 0xda;
const JPEG_EOI = 0xd9;

function jpegSegment(marker: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (data.length + 2) >> 8;
  out[3] = (data.length + 2) & 0xff;
  out.set(data, 4);
  return out;
}

function cleanJpeg(b: Uint8Array, removed: Set<ImageDetail>): Uint8Array<ArrayBuffer> | null {
  const out: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  let i = 2;
  let scanned = false;
  for (;;) {
    if (i >= b.length) {
      // A file cut short in its image data still shows (as much as there is); before it, there is no image.
      if (scanned) return concat(out);
      return null;
    }
    if (b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) return null;
    const m = b[i++]!;
    if (m === JPEG_EOI) {
      out.push(new Uint8Array([0xff, JPEG_EOI]));
      if (hasData(b.subarray(i))) removed.add('appended');
      return concat(out);
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      out.push(new Uint8Array([0xff, m]));
      continue;
    }
    if (i + 2 > b.length) return null;
    const len = u16be(b, i);
    if (len < 2 || i + len > b.length) return null;
    const data = b.subarray(i + 2, i + len);
    i += len;
    const kept = jpegKeep(m, data, removed);
    if (kept) out.push(kept);
    if (m === JPEG_SOS) {
      scanned = true;
      // The image data, to the next marker: 0xFF 0x00 is a 0xFF in the data, 0xFF 0xD0–D7 a restart, 0xFF 0xFF fill.
      let j = i;
      while (j < b.length) {
        if (b[j] !== 0xff) {
          j++;
          continue;
        }
        const n = b[j + 1];
        if (n === undefined) {
          j++;
          break;
        }
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) j += 2;
        else if (n === 0xff) j++;
        else break;
      }
      out.push(b.subarray(i, j));
      i = j;
    }
  }
}

/** A JPEG segment as kept (perhaps rewritten), or null if it is dropped. */
function jpegKeep(m: number, data: Uint8Array, removed: Set<ImageDetail>): Uint8Array | null {
  if (m === 0xe0) {
    // JFIF: kept, without the thumbnail it may hold. JFXX (an extension, for thumbnails) and others: dropped.
    if (startsWith(data, 'JFIF\0') && data.length >= 14) {
      if (data.length === 14 && data[12] === 0 && data[13] === 0) return jpegSegment(m, data);
      const jfif = data.slice(0, 14);
      if (data[12] || data[13]) removed.add('thumbnail');
      jfif[12] = 0;
      jfif[13] = 0;
      return jpegSegment(m, jfif);
    }
    removed.add(startsWith(data, 'JFXX\0') ? 'thumbnail' : 'other');
    return null;
  }
  if (m === 0xe1) {
    if (startsWith(data, 'Exif\0\0')) {
      const { orientation } = readExif(data.subarray(6), removed);
      if (orientation === 1) return null;
      return jpegSegment(m, concat([new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]), exifOfOrientation(orientation)]));
    }
    if (startsWith(data, 'http://ns.adobe.com/')) readXmp(utf8(data), removed);
    else removed.add('other');
    return null;
  }
  if (m === 0xe2) {
    // A colour profile is kept; MPF (more images: a phone's depth map, a camera's preview) is not.
    if (startsWith(data, 'ICC_PROFILE\0')) return jpegSegment(m, data);
    removed.add(startsWith(data, 'MPF\0') ? 'appended' : 'other');
    return null;
  }
  // Adobe's says how the colours are stored: kept.
  if (m === 0xee && startsWith(data, 'Adobe')) return jpegSegment(m, data);
  if (m === 0xfe) {
    removed.add('description');
    return null;
  }
  if (m === 0xed) {
    readPhotoshop(data, removed);
    return null;
  }
  if (m >= 0xe0 && m <= 0xef) {
    removed.add('other');
    return null;
  }
  return jpegSegment(m, data);
}

/**
 * Photoshop's resources (JPEG's APP13): IPTC (captions, keywords, places,
 * names) and thumbnails say something; the rest (a digest, settings) nothing.
 */
function readPhotoshop(data: Uint8Array, removed: Set<ImageDetail>) {
  if (!startsWith(data, 'Photoshop 3.0\0')) {
    removed.add('other');
    return;
  }
  let i = 14;
  while (i + 12 <= data.length && startsWith(data, '8BIM', i)) {
    const id = u16be(data, i + 4);
    const nameLength = data[i + 6]!;
    const at = i + 6 + ((nameLength + 2) & ~1);
    if (at + 4 > data.length) return;
    const size = u32be(data, at);
    if (id === 0x0404 && size > 0) removed.add('description');
    else if ((id === 0x0409 || id === 0x040c) && size > 0) removed.add('thumbnail');
    i = at + 4 + size + (size & 1);
  }
}

// ---------------------------------------------------------------------------
// PNG: chunks the picture needs are kept, the rest dropped (eXIf replaced);
// nothing after its end.

const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'cLLI', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT']);

const PNG_TEXT: Record<string, ImageDetail> = {
  Title: 'description', Description: 'description', Comment: 'description', Disclaimer: 'description', Warning: 'description',
  Author: 'author', Copyright: 'author', 'Creation Time': 'date', Software: 'software', Source: 'camera',
};

let crcTable: Uint32Array | null = null;
function crc32(b: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function cleanPng(b: Uint8Array, removed: Set<ImageDetail>): Uint8Array<ArrayBuffer> | null {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const end = i + 12 + len;
    if (end > b.length) return null;
    const type = ascii(b, i + 4, 4);
    const data = b.subarray(i + 8, i + 8 + len);
    if (PNG_KEEP.has(type)) out.push(b.subarray(i, end));
    else if (type === 'eXIf') {
      const { orientation } = readExif(data, removed);
      if (orientation !== 1) out.push(pngChunk('eXIf', exifOfOrientation(orientation)));
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const nul = data.indexOf(0);
      const keyword = ascii(data, 0, nul < 0 ? Math.min(data.length, 79) : nul);
      // An uncompressed iTXt can be read; XMP is one.
      if (keyword === 'XML:com.adobe.xmp' && type === 'iTXt' && data[nul + 1] === 0) readXmp(utf8(data.subarray(nul + 1)), removed);
      else if (/exif/i.test(keyword)) removed.add('camera');
      else removed.add(PNG_TEXT[keyword] ?? 'other');
    } else if (type === 'tIME') removed.add('date');
    // Anything else is the software's own (a decoder's hints, an editor's layers): dropped, nothing to say.
    i = end;
    if (type === 'IEND') {
      if (hasData(b.subarray(i))) removed.add('appended');
      return concat(out);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// WebP: a RIFF file of chunks; EXIF replaced, XMP and others dropped, and the
// header's flags and size made to agree.

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

function riffChunk(type: string, data: Uint8Array): Uint8Array {
  const pad = data.length & 1;
  const out = new Uint8Array(8 + data.length + pad);
  for (let k = 0; k < 4; k++) out[k] = type.charCodeAt(k);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

function cleanWebp(b: Uint8Array, removed: Set<ImageDetail>): Uint8Array<ArrayBuffer> | null {
  const declared = u32le(b, 4) + 8;
  const end = Math.min(declared, b.length);
  if (declared < b.length && hasData(b.subarray(declared))) removed.add('appended');
  const chunks: { type: string; data: Uint8Array }[] = [];
  let i = 12;
  while (i + 8 <= end) {
    const type = ascii(b, i, 4);
    const len = u32le(b, i + 4);
    if (i + 8 + len > end) return null;
    const data = b.subarray(i + 8, i + 8 + len);
    i += 8 + len + (len & 1);
    if (WEBP_KEEP.has(type)) chunks.push({ type, data });
    else if (type === 'EXIF') {
      const tiff = startsWith(data, 'Exif\0\0') ? data.subarray(6) : data;
      const { orientation } = readExif(tiff, removed);
      if (orientation !== 1) chunks.push({ type, data: exifOfOrientation(orientation) });
    } else if (type === 'XMP ') readXmp(utf8(data), removed);
    else removed.add('other');
  }
  if (!chunks.length) return null;
  const vp8x = chunks.find((c) => c.type === 'VP8X');
  if (vp8x && vp8x.data.length >= 1) {
    const data = vp8x.data.slice();
    // Flags: 0x08 EXIF, 0x04 XMP.
    data[0] = (data[0]! & ~0x0c) | (chunks.some((c) => c.type === 'EXIF') ? 0x08 : 0);
    vp8x.data = data;
  }
  const body = concat(chunks.map((c) => riffChunk(c.type, c.data)));
  const head = new Uint8Array(12);
  head.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  head.set([0x57, 0x45, 0x42, 0x50], 8);
  return concat([head, body]);
}

// ---------------------------------------------------------------------------
// GIF: blocks; images, their timing, looping and colour profile kept; comments
// and others' application data dropped; nothing after its end.

function cleanGif(b: Uint8Array, removed: Set<ImageDetail>): Uint8Array<ArrayBuffer> | null {
  if (b.length < 13) return null;
  const packed = b[10]!;
  let i = 13 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
  if (i > b.length) return null;
  const out: Uint8Array[] = [b.subarray(0, i)];
  /** The end of the sub-blocks starting at j (after the empty one), or -1. */
  const blocks = (j: number) => {
    while (j < b.length) {
      const n = b[j]!;
      j += 1 + n;
      if (n === 0) return j;
    }
    return -1;
  };
  while (i < b.length) {
    const kind = b[i]!;
    if (kind === 0x3b) {
      out.push(b.subarray(i, i + 1));
      if (hasData(b.subarray(i + 1))) removed.add('appended');
      return concat(out);
    }
    if (kind === 0x2c) {
      if (i + 10 > b.length) return null;
      const p = b[i + 9]!;
      const start = i + 10 + (p & 0x80 ? 3 * (1 << ((p & 7) + 1)) : 0) + 1;
      const end = blocks(start);
      if (end < 0) return null;
      out.push(b.subarray(i, end));
      i = end;
      continue;
    }
    if (kind !== 0x21 || i + 2 > b.length) return null;
    const label = b[i + 1]!;
    const end = blocks(i + 2);
    if (end < 0) return null;
    const id = label === 0xff && b[i + 2] === 11 ? ascii(b, i + 3, 11) : '';
    // Timing and transparency (F9), text drawn in the picture (01), looping, the colour profile.
    if (label === 0xf9 || label === 0x01 || id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0' || id === 'ICCRGBG1012') out.push(b.subarray(i, end));
    else if (label === 0xfe) removed.add('description');
    else if (id === 'XMP DataXMP') readXmp(utf8(b.subarray(i + 14, end)), removed);
    else removed.add('other');
    i = end;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SVG: text. Comments, <metadata>, and the drawing software's own elements and
// attributes (Inkscape's, which name the files it was saved and exported as;
// Illustrator's private copy of the whole drawing) are dropped; the rest is
// kept as written.

const SVG_DROP = new Set(['metadata', 'sodipodi:namedview', 'i:pgf']);

/** The index after the tag starting at i: its `>`, outside quotes. */
function tagEnd(s: string, i: number): number {
  let quote = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return j + 1;
  }
  return s.length;
}

function cleanSvg(b: Uint8Array, removed: Set<ImageDetail>): Uint8Array<ArrayBuffer> | null {
  const s = utf8(b);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    i = lt;
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      const text = s.slice(i + 4, end < 0 ? s.length : end);
      removed.add(/generator|created with|exported|inkscape|illustrator|sketch|figma|affinity|corel/i.test(text) ? 'software' : 'description');
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', i) || s.startsWith('<?', i)) {
      const close = s.startsWith('<?', i) ? '?>' : ']]>';
      const end = s.indexOf(close, i);
      const stop = end < 0 ? s.length : end + close.length;
      out += s.slice(i, stop);
      i = stop;
      continue;
    }
    if (s.startsWith('<!', i)) {
      // A DOCTYPE, its internal subset in brackets.
      let j = i + 2;
      let depth = 0;
      for (; j < s.length; j++) {
        if (s[j] === '[') depth++;
        else if (s[j] === ']') depth--;
        else if (s[j] === '>' && depth <= 0) break;
      }
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const end = tagEnd(s, i);
    let tag = s.slice(i, end);
    i = end;
    const m = /^<(\/?)([^\s/>]+)/.exec(tag);
    if (!m) {
      out += tag;
      continue;
    }
    const name = m[2]!;
    const local = name.slice(name.indexOf(':') + 1);
    if (!m[1] && (SVG_DROP.has(name) || local === 'metadata')) {
      let content = '';
      if (!/\/\s*>$/.test(tag)) {
        const close = new RegExp(`</${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, 'g');
        close.lastIndex = i;
        const found = close.exec(s);
        content = s.slice(i, found ? found.index : s.length);
        i = found ? close.lastIndex : s.length;
      }
      if (local === 'metadata') readXmp(content, removed);
      else removed.add('software');
      continue;
    }
    if (!m[1]) {
      tag = tag.replace(/\s+(?:sodipodi|inkscape):[\w.-]+\s*=\s*(?:"[^"]*"|'[^']*')/g, () => {
        removed.add('software');
        return '';
      });
    }
    out += tag;
  }
  return new TextEncoder().encode(out);
}
