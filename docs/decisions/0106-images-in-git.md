# 0106 · Images and other binary files: in git, cleaned on the way in, shown before they are kept

**Status: built** (cleaning, the dialog, the history's size). **Partial clones: not built**; what is
built leaves room for them (below). Adds to [0040](0040-writing-in-the-editor.md) (images pasted or
dropped into a document).

The owner asked how images and other large binary files should be kept (git LFS, S3, plain git), then:

> "Let's not implement partial clones yet, but build everything in a way that can adapt that down the
> road. For now, implement the image/binary structure you've described, standard git, with metadata
> removal and optional resizing of images. Make a nice upload dialog that communicates to people the
> size of the binary file being stored."

## Where binary files are kept: in git, as any file

An image is a file in the workspace, committed as any file is (0040: in `images/` beside its document,
under a safe name, the same image again reusing its file). Only git gives a binary file what every other
file has without more work: signed commits and the write gate ([0066](0066-permissions-without-a-centre.md)),
spaces and who reads them, the sealed packs of [0073](0073-encrypted-spaces.md), history and restoring
past versions, and an online copy ([0039](0039-online-copy.md)) on any git server that a plain clone
reads whole.

- **Not git LFS.** It needs an LFS server on every way files travel (between devices over the peer
  network, servers that need only Node and git ([0052](0052-the-server-updates-itself.md)), any git
  server as the online copy), the `git-lfs` program and its filters on every computer, and it leaves
  pointer files in the online copy instead of pictures. Its objects are fetched by their hash, around
  spaces' readers (what [0071](0071-network-review.md) closed), and kept in the clear, which 0073 must
  not do.
- **Not S3 (or any store beside git).** A centre, credentials and a network every file depends on, in a
  design that has none; and its permissions are not spaces'. A store that holds sealed packs for
  people away (0073's holders) could later be one, as a sync component ([0059](0059-online-copy-is-a-component.md)).
- **Not in the document** (a `data:` address in the text): it would swell the file, its live room, the
  merge of its words, and search.

Git keeps every version of every file for good, and a file taken out of a document stays in the history
(it cannot be rewritten: commits are signed). So the cost of a binary file is paid when it is added:
that is where it is made smaller, and where people are told what it costs.

## Details removed: `cleanImage` (`@kuraa/kernel`, `images.ts`)

An image file carries more than its picture: a phone's photo says where it was taken (GPS), the camera
and its serial number, and when; editors add who made it, the software and its history; some keep a
thumbnail of the uncropped original, or another picture or a video after the image's end (a camera's
preview, a phone's depth map, a motion photo). Kept in a shared history, all of it goes to everyone in
the workspace for good.

`cleanImage(bytes)` reads each kind's structure and keeps only what the picture needs to look the
same:

| Kind | Kept | Removed |
| --- | --- | --- |
| JPEG | JFIF (without its thumbnail), colour profile (`ICC_PROFILE`), Adobe's colour segment, the image's own tables and data | EXIF (but its orientation), XMP, comments, Photoshop's IPTC and thumbnails, MPF, every other APPn, everything after the end |
| PNG | the chunks of the picture, its colours and animation (`IHDR` `PLTE` `IDAT` `IEND` `tRNS` `cHRM` `gAMA` `iCCP` `sBIT` `sRGB` `cICP` `mDCV` `cLLI` `bKGD` `hIST` `pHYs` `sPLT` `acTL` `fcTL` `fdAT`) | text (`tEXt` `zTXt` `iTXt`, so XMP), `eXIf` (but its orientation), `tIME`, any other chunk, everything after the end |
| WebP | `VP8 ` `VP8L` `VP8X` `ALPH` `ANIM` `ANMF` `ICCP` (the header's flags and size made to agree) | `EXIF` (but its orientation), `XMP `, any other chunk, anything after the RIFF |
| GIF | frames, their timing (`F9`), text drawn in the picture (`01`), looping (`NETSCAPE2.0`, `ANIMEXTS1.0`), the colour profile | comments, XMP, every other application block, everything after the end |
| SVG | the drawing as written | comments, `<metadata>`, Inkscape's and Sodipodi's attributes and `namedview` (they name the files it was saved and exported as, with their folders), Illustrator's private copy of the drawing (`i:pgf`) |

- **The orientation is kept**, as an EXIF of one entry, because without it a phone's photo shows on its
  side. Nothing else of EXIF is.
- **It says what it removed**, by kind (where it was taken, the camera, when, who, descriptions, a
  thumbnail, what came after the picture, the software, other details), for the dialog to tell. A part
  that says nothing (an empty Photoshop block, a decoder's hints) is removed without saying so.
- **Clean is clean**: cleaning a cleaned file gives the same bytes and removes nothing. So the page can
  clean an image to show exactly how large it will be, and the host clean it again (it does not trust
  the page) with the same result.
- **A file whose structure cannot be read is refused** by the host ("may be damaged"): what it carries
  could not be found. The dialog saves such a file again from its picture, where the browser can show it.
- It runs without the DOM or Node, in the kernel, so the host and the page use the one implementation.

## The dialog (`ImagesDialog.vue`; `EditorUi.chooseImages`)

Images pasted or dropped into a document no longer go straight in. The format's editor module holds
their place (it moves with edits around it) and asks the client, through the new
`EditorUi.chooseImages`, how to add them. For each image the dialog shows:

- its picture, name, size in pixels and kind;
- **how large it is as kept**, beside its file's size where that differs ("3.1 MB → 66 KB");
- **a size to choose**: its full size and, for JPEG, PNG and WebP larger than them, 2560, 1600 and 1024
  pixels on the longest side, each with how large it would be as kept (made one after another as the
  dialog shows, a size no smaller than the full one not offered). The full size is chosen unless it is
  larger than 20 MB, the most an image may be; then the largest size under it. GIFs (their animation)
  and SVGs are kept at their own size;
- **its description** (alt text), from its file's name, none for an image pasted with no name of its
  own, focused first;
- **what was removed from its file**, in words ("Removed from the file: where it was taken and the camera
  and its settings."), or that only the picture was there.

Below them, for them all: **what they add to the workspace**, beside how large its history is on this
computer now (`GET /api/storage`, from `git count-objects`), drawn as a bar; that it is large for a
document where it is over 1 MB and a smaller size would do; and that everyone in the workspace
downloads what is added, and it stays in the workspace's history even if it is taken out of the
document later. **Add** keeps them, in order, where they were put; Escape or Cancel adds nothing.

A smaller size is drawn again in a canvas from the decoded picture (turned the right way up), in the
same format (JPEG and WebP at 0.88), and cleaned. It carries only its pixels, in sRGB: a canvas keeps
no colour profile, so a wide-gamut photo made smaller loses its wider colours. A file up to 200 MB can
be chosen (to make smaller; more takes too much memory to decode); what is kept is at most 20 MB, as
before. Where there is no dialog (no client to draw it), images are added as they are, cleaned by the
host.

## Room for partial clones later

A partial clone would keep every commit and folder listing on each device and fetch a large file's
contents only when it is needed, from a device that holds them all (a server, the online copy). Not
built; what is built keeps the way open:

- **One way in.** Images enter through `addImage` on the host, cleaned; their size is decided there.
- **One way out to the page.** The page reads a workspace's binary files only through `GET /api/raw`
  (`WorkspaceFiles.imageUrl`), the one place a file not yet fetched would be fetched. Renders and runs
  read the working tree and would need a file fetched before they start.
- **One size for "large".** `LARGE_FILE_BYTES` (1 MiB, in the kernel) is what the dialog calls large,
  and the size a partial clone would leave out.
- **Content, not names.** The same picture is the same blob, in git and in `images/`, so a device
  fetching it once has it for every document that shows it.
- **Fetching by content needs a check of its own.** Git's own partial clone fetches a missing file by
  its id, which serving turns off (0071, `uploadpack.allow*SHA1InWant=false`). Missing files would come
  over a channel of kuraa's own that checks the asker may read a space the file is in.

## Not done

- **Data files** (CSV, `.rds`, Parquet, PDFs) arrive through the file system, not this dialog, and are
  kept as they are. They are committed as any file, with no size limit but the peers' fetch's (2 GiB).
- **Images already in a workspace** are not cleaned: only those added from now on.
- **HEIC and AVIF** cannot be added (not every browser shows them), as before.
- **Adding an image checks no permission** of the folder it goes to, as before this: the write gate on
  the other devices keeps a change by someone who may not make it out.
