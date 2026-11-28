// Images' details (0108): where a photo was taken, the camera, when, who, a
// thumbnail, what is appended after the picture; found and removed in each kind
// of image, the picture and what it needs to look the same (its colour profile,
// its orientation, its looping) kept, and the same file again once clean.
import { describe, expect, it } from 'vitest';
import { cleanImage, sniffImage } from '../src/images.js';

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const bytes = (...parts: (Uint8Array | number[] | string)[]) => new Uint8Array(Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p)))));
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, 'latin1'));

// An 8×8 JPEG (JFIF, no other details) and PNG, and a 1×1 WebP and GIF.
const JPEG = b64('/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwDhvhR+yp/qf9D9P4a+hv8AhlT/AKc//Ha+gvhR/wAsfwr6Fr8/4o8Tc4+uS/e/1952eBXjDn3+rdD99+fZeZ//2Q==');
const PNG = b64('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAbElEQVR4nBXNQRUAUQhCUaMYhShGeVGIQhSizB+XXA7ODDtouIHBQ4YOM8suWm5h8ZKl+0CskDiBsIioHhx76LiDw0eO3oN/4FVf+J8h0PduzBqZ8x/bxNQPwgaFy192SGgelC0q13/CJaXlA8Z7WAGfV950AAAAAElFTkSuQmCC');
const WEBP = b64('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==');
const GIF = b64('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==');

// --- EXIF, as a phone writes it: a big-endian TIFF of directories.
type Entry = [tag: number, type: number, value: number | string];
const u16 = (n: number) => [n >> 8, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const extraOf = (v: number | string) => (typeof v === 'string' && v.length + 1 > 4 ? (v.length + 2) & ~1 : 0);
const ifdSize = (entries: Entry[]) => 2 + 12 * entries.length + 4 + entries.reduce((n, [, , v]) => n + extraOf(v), 0);
function ifd(entries: Entry[], at: number, next: number): number[] {
  const out = [...u16(entries.length)];
  const extra: number[] = [];
  let data = at + 2 + 12 * entries.length + 4;
  for (const [tag, type, v] of entries) {
    out.push(...u16(tag), ...u16(type));
    if (typeof v === 'string') {
      const s = [...Buffer.from(`${v}\0`, 'latin1')];
      out.push(...u32(s.length));
      if (s.length <= 4) out.push(...s, ...Array(4 - s.length).fill(0));
      else {
        out.push(...u32(data));
        if (s.length & 1) s.push(0);
        extra.push(...s);
        data += s.length;
      }
    } else out.push(...u32(1), ...(type === 3 ? [...u16(v), 0, 0] : u32(v)));
  }
  return [...out, ...u32(next), ...extra];
}
/** EXIF: the main directory, perhaps the Exif and GPS ones it points at, and a thumbnail's. */
function exif(main: Entry[], sub: { exif?: Entry[]; gps?: Entry[]; thumbnail?: boolean } = {}): Uint8Array {
  const pointers: Entry[] = [...(sub.exif ? [[0x8769, 4, 0] as Entry] : []), ...(sub.gps ? [[0x8825, 4, 0] as Entry] : [])];
  const all = [...main, ...pointers];
  const exifAt = 8 + ifdSize(all);
  const gpsAt = exifAt + (sub.exif ? ifdSize(sub.exif) : 0);
  const thumbAt = gpsAt + (sub.gps ? ifdSize(sub.gps) : 0);
  for (const p of pointers) p[2] = p[0] === 0x8769 ? exifAt : gpsAt;
  const thumb: Entry[] = [[0x0201, 4, 0], [0x0202, 4, 0]];
  return new Uint8Array([
    0x4d, 0x4d, 0, 42, ...u32(8),
    ...ifd(all, 8, sub.thumbnail ? thumbAt : 0),
    ...(sub.exif ? ifd(sub.exif, exifAt, 0) : []),
    ...(sub.gps ? ifd(sub.gps, gpsAt, 0) : []),
    ...(sub.thumbnail ? ifd(thumb, thumbAt, 0) : []),
  ]);
}
const PHONE = exif(
  [[0x010f, 2, 'Apple'], [0x0110, 2, 'iPhone 15 Pro'], [0x0112, 3, 6], [0x0131, 2, '18.1']],
  { exif: [[0x9003, 2, '2026:11:20 14:02:11'], [0xa431, 2, 'C39XK2']], gps: [[0x0001, 2, 'N'], [0x0002, 5, 0]], thumbnail: true },
);
const XMP = '<x:xmpmeta><rdf:Description dc:creator="Ada Lovelace" xmp:CreatorTool="Lightroom"/></x:xmpmeta>';

const jpegSegment = (marker: number, ...data: (Uint8Array | number[] | string)[]) => {
  const body = bytes(...data);
  return bytes([0xff, marker, ...u16(body.length + 2)], body);
};
/** The JPEG's segments after its JFIF header: its tables, frame and image data. */
const JPEG_IMAGE = JPEG.subarray(20);
const ICC = jpegSegment(0xe2, 'ICC_PROFILE\0', [1, 1], 'a colour profile');

describe('images: sniffing', () => {
  it('knows each kind by its bytes', () => {
    expect(sniffImage(JPEG)).toBe('jpg');
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(WEBP)).toBe('webp');
    expect(sniffImage(GIF)).toBe('gif');
    expect(sniffImage(bytes('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg');
    expect(sniffImage(bytes('<html><body>not an image</body></html>'))).toBeNull();
    expect(sniffImage(bytes('hello'))).toBeNull();
  });
});

describe('images: JPEG', () => {
  it('removes where, the camera, when, who, thumbnails and what is appended; keeps the picture, its colour profile and its orientation', () => {
    const photo = bytes(
      JPEG.subarray(0, 20),
      jpegSegment(0xe1, 'Exif\0\0', PHONE),
      jpegSegment(0xe1, 'http://ns.adobe.com/xap/1.0/\0', XMP),
      jpegSegment(0xfe, 'a comment'),
      ICC,
      jpegSegment(0xe2, 'MPF\0', [0, 0, 0, 0]),
      JPEG_IMAGE,
      'a motion photo\'s video, appended',
    );
    const clean = cleanImage(photo)!;
    expect(clean.type).toBe('jpg');
    expect(clean.removed).toEqual(['location', 'camera', 'date', 'author', 'description', 'thumbnail', 'appended', 'software']);
    for (const s of ['Apple', 'iPhone', '2026:11:20', 'C39XK2', 'Ada', 'Lightroom', 'a comment', 'MPF', 'motion']) expect(has(clean.bytes, s), s).toBe(false);
    // The picture as it was, the profile, and an EXIF saying only "rotated" (6).
    expect(Buffer.from(clean.bytes).subarray(-JPEG_IMAGE.length).equals(Buffer.from(JPEG_IMAGE))).toBe(true);
    expect(has(clean.bytes, 'ICC_PROFILE\0')).toBe(true);
    expect(Buffer.from(clean.bytes).subarray(20, 20 + 36).toString('hex')).toBe(`ffe10022${Buffer.from('Exif\0\0').toString('hex')}4d4d002a00000008000101120003000000010006000000000000`);
    // Clean already: the same file, nothing to say.
    const again = cleanImage(clean.bytes)!;
    expect(Buffer.from(again.bytes).equals(Buffer.from(clean.bytes))).toBe(true);
    expect(again.removed).toEqual([]);
  });

  it('keeps no EXIF at all for a picture the right way up, and drops a JFIF thumbnail', () => {
    const jfif = bytes(JPEG.subarray(0, 4), JPEG.subarray(4, 18), [2, 1], [1, 2, 3, 4, 5, 6]);
    jfif[5] = 16 + 6;
    const clean = cleanImage(bytes(jfif, jpegSegment(0xe1, 'Exif\0\0', exif([[0x0112, 3, 1], [0x0132, 2, '2020:01:01 00:00:00']])), JPEG_IMAGE))!;
    expect(clean.removed).toEqual(['date', 'thumbnail']);
    expect(Buffer.from(clean.bytes).equals(Buffer.from(JPEG))).toBe(true);
  });

  it('says nothing of what says nothing (an empty Photoshop block), and refuses a file with no image', () => {
    const empty = jpegSegment(0xed, 'Photoshop 3.0\0', '8BIM', [4, 4, 0, 0, 0, 0, 0, 0]);
    expect(cleanImage(bytes(JPEG.subarray(0, 20), empty, JPEG_IMAGE))!.removed).toEqual([]);
    expect(cleanImage(JPEG.subarray(0, 40))).toBeNull();
  });
});

const pngChunk = (type: string, data: Uint8Array | string) => {
  const body = typeof data === 'string' ? bytes(data) : data;
  const typed = bytes(type, body);
  let c = 0xffffffff;
  for (const x of typed) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return bytes(u32(body.length), typed, u32((c ^ 0xffffffff) >>> 0));
};
/** A PNG's chunks, by type. */
function chunks(b: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 8; i + 12 <= b.length;) {
    const len = Buffer.from(b).readUInt32BE(i);
    out.push(Buffer.from(b.subarray(i + 4, i + 8)).toString('latin1'));
    i += 12 + len;
  }
  return out;
}

describe('images: PNG', () => {
  it('keeps the chunks the picture needs, EXIF only as its orientation; drops text, times, others\' chunks, what is appended', () => {
    const IHDR = PNG.subarray(8, 33);
    const rest = PNG.subarray(33);
    const png = bytes(
      PNG.subarray(0, 8), IHDR,
      pngChunk('sRGB', bytes([0])),
      pngChunk('tEXt', 'Author\0Ada'),
      pngChunk('iTXt', `XML:com.adobe.xmp\0\0\0\0\0${XMP}`),
      pngChunk('eXIf', exif([[0x0112, 3, 3]], { gps: [[0x0002, 5, 0]] })),
      pngChunk('tIME', bytes([7, 234, 11, 20, 14, 2, 11])),
      pngChunk('iDOT', bytes([0, 0, 0, 2])),
      rest,
      'appended',
    );
    const clean = cleanImage(png)!;
    expect(clean.removed).toEqual(['location', 'date', 'author', 'appended', 'software']);
    expect(chunks(clean.bytes)).toEqual(['IHDR', 'sRGB', 'eXIf', 'IDAT', 'IEND']);
    expect(has(clean.bytes, 'Ada')).toBe(false);
    // The new eXIf's check sum is right: cleaning again keeps it, and changes nothing.
    const again = cleanImage(clean.bytes)!;
    expect(Buffer.from(again.bytes).equals(Buffer.from(clean.bytes))).toBe(true);
    expect(again.removed).toEqual([]);
    expect(Buffer.from(clean.bytes).includes(pngChunk('eXIf', exif([[0x0112, 3, 3]]).subarray(0, 26)))).toBe(true);
  });

  it('leaves a clean PNG as it is, and refuses one cut short', () => {
    expect(Buffer.from(cleanImage(PNG)!.bytes).equals(Buffer.from(PNG))).toBe(true);
    expect(cleanImage(PNG.subarray(0, 50))).toBeNull();
  });
});

describe('images: WebP', () => {
  it('drops XMP and others, keeps EXIF only as the orientation, and makes the header agree', () => {
    const riff = (type: string, data: Uint8Array | string) => {
      const body = typeof data === 'string' ? bytes(data) : data;
      const size = Buffer.alloc(4);
      size.writeUInt32LE(body.length);
      return bytes(type, size, body, body.length & 1 ? [0] : []);
    };
    const vp8l = WEBP.subarray(12);
    const body = bytes(
      riff('VP8X', bytes([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
      vp8l,
      riff('EXIF', bytes('Exif\0\0', exif([[0x0112, 3, 8], [0x010f, 2, 'Canon']]))),
      riff('XMP ', XMP),
      riff('ZZZZ', 'other'),
    );
    const size = Buffer.alloc(4);
    size.writeUInt32LE(body.length + 4);
    const clean = cleanImage(bytes('RIFF', size, 'WEBP', body))!;
    expect(clean.removed).toEqual(['camera', 'author', 'software', 'other']);
    const out = Buffer.from(clean.bytes);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out[20]).toBe(0x08); // EXIF, no XMP
    expect(has(clean.bytes, 'Canon') || has(clean.bytes, 'XMP ') || has(clean.bytes, 'ZZZZ')).toBe(false);
    expect(has(clean.bytes, 'EXIF')).toBe(true);
    expect(Buffer.from(cleanImage(clean.bytes)!.bytes).equals(out)).toBe(true);
    expect(Buffer.from(cleanImage(WEBP)!.bytes).equals(Buffer.from(WEBP))).toBe(true);
  });
});

describe('images: GIF', () => {
  it('keeps frames, timing and looping; drops comments and XMP', () => {
    const head = GIF.subarray(0, 19); // header, screen, colours
    const frame = GIF.subarray(19, GIF.length - 1);
    const loop = bytes([0x21, 0xff, 11], 'NETSCAPE2.0', [3, 1, 0, 0, 0]);
    const comment = bytes([0x21, 0xfe, 9], 'a comment', [0]);
    const xmp = bytes([0x21, 0xff, 11], 'XMP DataXMP', [XMP.length], XMP, [0]);
    const clean = cleanImage(bytes(head, loop, comment, xmp, frame, [0x3b], 'after'))!;
    expect(clean.removed).toEqual(['author', 'description', 'appended', 'software']);
    expect(Buffer.from(clean.bytes).equals(Buffer.from(bytes(head, loop, frame, [0x3b])))).toBe(true);
    expect(Buffer.from(cleanImage(GIF)!.bytes).equals(Buffer.from(GIF))).toBe(true);
  });
});

describe('images: SVG', () => {
  it('drops comments, metadata and the drawing software\'s own; keeps the drawing as written', () => {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" sodipodi:docname="secret-plan.svg" inkscape:export-filename="/Users/ada/Desktop/plan.png" inkscape:version="1.3">
  <sodipodi:namedview id="nv" pagecolor="#fff"><inkscape:page x="0"/></sodipodi:namedview>
  <metadata><rdf:RDF><cc:Work><dc:creator>Ada</dc:creator></cc:Work></rdf:RDF></metadata>
  <style><![CDATA[ rect { fill: red } /* <!-- kept --> */ ]]></style>
  <rect width="4" height="4" title="a > b"/>
</svg>`;
    const clean = cleanImage(bytes(svg))!;
    const text = Buffer.from(clean.bytes).toString('utf8');
    expect(clean.removed).toEqual(['author', 'software']);
    for (const s of ['Inkscape', 'secret-plan', '/Users/ada', 'namedview', 'dc:creator', 'inkscape:version']) expect(text, s).not.toContain(s);
    expect(text).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4">');
    expect(text).toContain('<![CDATA[ rect { fill: red } /* <!-- kept --> */ ]]>');
    expect(text).toContain('<rect width="4" height="4" title="a > b"/>');
    expect(cleanImage(clean.bytes)!.removed).toEqual([]);
    expect(Buffer.from(cleanImage(clean.bytes)!.bytes).toString('utf8')).toBe(text);
  });
});
