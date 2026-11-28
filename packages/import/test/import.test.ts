// Importing (0116): a Word document split into documents; a Scrivener project's
// binder, details, compile settings, research and notes; what the plan writes.
import { describe, expect, it } from 'vitest';
import { headingsUp, plainTitle, planWord } from '../src/word.js';
import { anchorNotes, itemFiles, planScrivener, projectFile, readNotes, readProject, readProjectNotes } from '../src/scrivener.js';
import { documentText, isoDate, writePlan, type PlannedFolder } from '../src/plan.js';
import { readPage } from '@kuraa/annotations/format';
import { scrivenerWants } from '../src/choose.js';
import type { ConvertedFile } from '@kuraa/feature-kit/host';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const text = (files: { path: string; text?: string }[], path: string) => files.find((f) => f.path === path)?.text;

describe('a Word document', () => {
  const md = [
    '---', 'title: The Coast', 'author:', '- Ada Byron', '---', '',
    'A preface.', '',
    '# Arrival {#arrival}', '', 'We came. ![A map](/out/media/media/image1.png)', '', '## The quay', '', 'Boats.', '', '```', '# not a heading', '```', '',
    '# *Departure*', '', 'We left.', '',
  ].join('\n');
  const media = [{ name: '/out/media/media/image1.png', bytes: PNG }];

  it('is split where its chapters begin: each a document titled by its heading, its sections a level up; what comes before, a document of its own', () => {
    const f = planWord(md, 'coast', 'chapters', media);
    expect(f.title).toBe('The Coast');
    expect(f.compile).toEqual({ title: 'The Coast', author: 'Ada Byron' });
    expect(f.items.map((i) => (i.kind === 'document' ? i.title : i.kind))).toEqual([null, 'Arrival', 'Departure']);
    const arrival = f.items[1]!;
    expect(arrival.kind === 'document' && arrival.body).toBe('We came. ![A map](/out/media/media/image1.png)\n\n# The quay\n\nBoats.\n\n```\n# not a heading\n```');
  });

  it('is split at its sections too, its chapters folders; or kept whole', () => {
    const f = planWord(md, 'coast', 'sections', media);
    expect(f.items.map((i) => (i.kind === 'folder' ? `folder ${i.title}` : i.kind === 'document' ? i.title : ''))).toEqual([null, 'folder Arrival', 'folder Departure']);
    const arrival = f.items[1] as PlannedFolder;
    expect(arrival.items.map((i) => (i.kind === 'document' ? i.title : ''))).toEqual([null, 'The quay']);
    expect(planWord(md, 'coast', 'none', media).items).toHaveLength(1);
    expect(planWord('Just words.\n', 'notes', 'chapters', []).items.map((i) => i.kind === 'document' && i.title)).toEqual(['notes']);
  });

  it('gives headings’ words without their Markdown, and moves headings up outside code', () => {
    expect(plainTitle('*The* [coast](http://x) \\# 1[^1]')).toBe('The coast # 1');
    expect(headingsUp('## A\n```\n## b\n```\n### C', 1)).toBe('# A\n```\n## b\n```\n## C');
  });
});

describe('what a plan writes', () => {
  it('names documents from their titles, puts their images in their own files folder, keeps each folder’s order and what Compile keeps', () => {
    const plan: PlannedFolder = {
      kind: 'folder', title: 'The Coast: a novel?', compile: { title: 'The Coast', author: 'Ada' }, items: [
        { kind: 'document', title: null, name: 'The Coast', body: 'Before.', media: [] },
        { kind: 'document', title: 'Arrival', details: { synopsis: 'They come.', label: 'Plot', status: 'First draft', keywords: ['sea'] }, body: 'A ![map](/out/media/media/image1.png).', media: [{ name: '/out/media/media/image1.png', bytes: PNG }] },
        { kind: 'folder', title: 'Part Two', items: [], leftOut: true },
        { kind: 'file', title: 'Map of the coast', extension: '.pdf', bytes: new Uint8Array([1, 2]) },
      ],
    };
    const w = writePlan(plan, 'books', ['The Coast a novel']);
    expect(w.root).toBe('books/The Coast a novel 2');
    const at = (p: string) => `books/The Coast a novel 2/${p}`;
    expect(w.files.map((f) => f.path).sort()).toEqual([at('.kuraa-compile.yml'), at('.kuraa-order'), at('Part Two/.gitkeep'), at('arrival.md'), at('arrival.md.files/image1.png'), at('map-of-the-coast.pdf'), at('the-coast.md')].sort());
    expect(text(w.files, at('the-coast.md'))).toBe('Before.\n');
    expect(text(w.files, at('arrival.md'))).toBe('---\ntitle: Arrival\nsynopsis: They come.\nlabel: Plot\nstatus: First draft\nkeywords:\n  - sea\n---\n\nA ![map](arrival.md.files/image1.png).\n');
    expect(text(w.files, at('.kuraa-order'))).toMatch(/\nthe-coast\.md\narrival\.md\nPart Two\nmap-of-the-coast\.pdf\n$/);
    expect(text(w.files, at('.kuraa-compile.yml'))).toMatch(/title: The Coast\nauthor: Ada\n[\s\S]*exclude:\n {2}- Part Two\n/);
    expect(w).toMatchObject({ first: at('the-coast.md'), documents: 2, folders: 2, images: 1, others: 1 });
    expect(documentText(null, undefined, '')).toBe('');
  });
});

/** A project's file, Scrivener 3's way (UUIDs) or 2's (IDs). */
const SCRIVX = (id: (n: number) => string, attr: string) => `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject Version="2.0">
  <Binder>
    <BinderItem ${attr}="${id(1)}" Type="DraftFolder"><Title>Manuscript</Title><Children>
      <BinderItem ${attr}="${id(2)}" Type="Text"><Title>Chapter One</Title>
        <MetaData><LabelID>1</LabelID><StatusID>2</StatusID><IncludeInCompile>Yes</IncludeInCompile></MetaData>
        <Keywords><KeywordID>7</KeywordID></Keywords>
        <Children>
          <BinderItem ${attr}="${id(3)}" Type="Text"><Title>The quay</Title><MetaData><IncludeInCompile>Yes</IncludeInCompile><KeywordRef ID="8"/></MetaData></BinderItem>
          <BinderItem ${attr}="${id(4)}" Type="Text"><Title>Cut scene</Title><MetaData><IncludeInCompile>No</IncludeInCompile></MetaData></BinderItem>
        </Children>
      </BinderItem>
    </Children></BinderItem>
    <BinderItem ${attr}="${id(5)}" Type="ResearchFolder"><Title>Research</Title><Children>
      <BinderItem ${attr}="${id(6)}" Type="PDF"><Title>Tide tables</Title></BinderItem>
      <BinderItem ${attr}="${id(9)}" Type="WebArchive"><Title>A page</Title></BinderItem>
    </Children></BinderItem>
    <BinderItem ${attr}="${id(10)}" Type="TrashFolder"><Title>Trash</Title><Children>
      <BinderItem ${attr}="${id(11)}" Type="Text"><Title>Gone</Title></BinderItem>
    </Children></BinderItem>
  </Binder>
  <LabelSettings><Labels><Label ID="-1">No Label</Label><Label ID="1" Color="0.9 0.5 0.5">Plot</Label></Labels></LabelSettings>
  <StatusSettings><StatusItems><Status ID="-1">No Status</Status><Status ID="2">First Draft</Status></StatusItems></StatusSettings>
  <Keywords><Keyword ID="7"><Title>sea</Title></Keyword><Keyword ID="8"><Title>night</Title></Keyword></Keywords>
  <ProjectProperties><ProjectTitle>The Coast</ProjectTitle><FullName>Ada Byron</FullName></ProjectProperties>
  <ProjectTargets><DraftTarget Type="Words">80000</DraftTarget></ProjectTargets>
</ScrivenerProject>`;

/** A convert that reads "RTF" as its text, a comment link in it as pandoc writes one. */
const fakeConvert = async (_n: string, b: Uint8Array): Promise<ConvertedFile> => ({ ok: true, markdown: new TextDecoder().decode(b), media: [] });
const enc = (s: string) => new TextEncoder().encode(s);

describe('a Scrivener project', () => {
  it('reads its binder, labels, statuses, keywords, title, author and target', () => {
    const p = readProject(SCRIVX((n) => `U-${n}`, 'UUID'));
    expect(p).toMatchObject({ title: 'The Coast', author: 'Ada Byron', target: 80000 });
    const ch = p.items[0]!.children[0]!;
    expect(ch).toMatchObject({ id: 'U-2', type: 'Text', title: 'Chapter One', label: 'Plot', status: 'First Draft', keywords: ['sea'], include: true });
    expect(ch.children.map((c) => [c.title, c.include, c.keywords])).toEqual([['The quay', true, ['night']], ['Cut scene', false, []]]);
    expect(() => readProject('<html/>')).toThrow(/not a Scrivener project/);
  });

  it('finds its project file, and each item’s text, synopsis, notes and media, Scrivener 3’s way or 2’s', () => {
    expect(projectFile(['Coast.scrivx', 'Coast (conflicted copy).scrivx', 'Files/x'], 'Coast')).toBe('Coast.scrivx');
    expect(projectFile(['Coast (Benedict’s conflicted copy).scrivx', 'Old.scrivx'], 'Coast')).toBe('Old.scrivx');
    const v3 = ['Files/Data/U-2/content.rtf', 'Files/Data/U-2/synopsis.txt', 'Files/Data/U-2/notes.rtf', 'Files/Data/U-6/content.pdf', 'Files/Data/U-2/content.styles'];
    expect(itemFiles('U-2', (p) => v3.includes(p), v3)).toEqual({ text: 'Files/Data/U-2/content.rtf', synopsis: 'Files/Data/U-2/synopsis.txt', notes: 'Files/Data/U-2/notes.rtf', comments: null, media: null });
    expect(itemFiles('U-6', (p) => v3.includes(p), v3).media).toBe('Files/Data/U-6/content.pdf');
    const v2 = ['Files/Docs/12.rtf', 'Files/Docs/12_synopsis.txt', 'Files/Docs/12.links', 'Files/Docs/120.rtf', 'Files/Docs/6.pdf'];
    expect(itemFiles('12', (p) => v2.includes(p), v2)).toEqual({ text: 'Files/Docs/12.rtf', synopsis: 'Files/Docs/12_synopsis.txt', notes: null, comments: 'Files/Docs/12.links', media: null });
    expect(itemFiles('6', (p) => v2.includes(p), v2).media).toBe('Files/Docs/6.pdf');
  });

  it('reads comments and linked footnotes, Scrivener 2’s way (.links) and 3’s (content.comments)', () => {
    const v2 = '<?xml version="1.0"?><Links Version="1.0" Anchor="RTF"><CommentsAndFootnotes>'
      + '<Comment IsFootnote="No" Collapsed="No" ID="C-1"><Range>10,8</Range><Color>1 0.9 0.4</Color><RTF><![CDATA[{\\rtf1 Is this right?}]]></RTF></Comment>'
      + '<Comment IsFootnote="Yes" FootnoteNumber="1" ID="F-1"><Range>30,4</Range><Color>0 0 1</Color><RTF><![CDATA[{\\rtf1 A source.}]]></RTF></Comment>'
      + '</CommentsAndFootnotes></Links>';
    expect(readNotes(v2)).toEqual([
      { id: 'C-1', footnote: false, author: null, date: null, rtf: '{\\rtf1 Is this right?}' },
      { id: 'F-1', footnote: true, author: null, date: null, rtf: '{\\rtf1 A source.}' },
    ]);
    const v3 = '<?xml version="1.0"?><Comments><Comment ID="C-2" Footnote="No" Author="Ada" Date="2026-06-15 09:14:00 +0200" Color="1 0.8 0.4"><![CDATA[{\\rtf1 Tighten.}]]></Comment></Comments>';
    expect(readNotes(v3)).toEqual([{ id: 'C-2', footnote: false, author: 'Ada', date: '2026-06-15 09:14:00 +0200', rtf: '{\\rtf1 Tighten.}' }]);
    expect(isoDate('2026-06-15 09:14:00 +0200')).toBe('2026-06-15T07:14:00.000Z');
    expect(isoDate('not a date')).toBeNull();
    expect(readProjectNotes('<ProjectNotes Version="1.0"><Note ID="5" Modified="x"><Title>Ideas</Title></Note></ProjectNotes>')).toEqual([{ id: '5', title: 'Ideas' }]);
  });

  it('sends only what the import reads: texts, synopses, notes, comments, project notes, research', () => {
    const sent = ['P.scrivx', 'P (x’s conflicted copy).scrivx', 'Files/Docs/2.rtf', 'Files/Docs/2.links', 'Files/Docs/2_notes.rtf', 'Files/Docs/docs.checksum', 'Files/Docs/2.styles',
      'Files/ProjectNotes/index.xml', 'Files/ProjectNotes/7.rtf', 'Files/Data/U/content.rtf', 'Files/Data/U/content.comments', 'Files/Data/U/content.styles', 'Files/Data/U/content.png',
      'Files/search.indexes', 'Snapshots/U.snapshots/x.rtf', 'Settings/ui.plist'].filter(scrivenerWants);
    expect(sent).toEqual(['P.scrivx', 'Files/Docs/2.rtf', 'Files/Docs/2.links', 'Files/Docs/2_notes.rtf', 'Files/ProjectNotes/index.xml', 'Files/ProjectNotes/7.rtf', 'Files/Data/U/content.rtf', 'Files/Data/U/content.comments', 'Files/Data/U/content.png']);
  });

  it('makes a comment’s link its words and a comment quoting them, a footnote’s a footnote; a note not in the text, a comment on the document', () => {
    const notes = new Map([
      ['C-1', { footnote: false, body: 'Is *this* right?', author: null, date: null }],
      ['F-1', { footnote: true, body: 'A source.\n\nAnd more.', author: null, date: null }],
      ['C-9', { footnote: false, body: 'About it all.', author: 'Ada', date: null }],
    ]);
    const r = anchorNotes('He was [a *sailor*](scrivcmt://C-1) once, [there](scrivcmt://F-1){.x}, and [here](scrivcmt://gone).', notes);
    expect(r.text).toBe('He was a *sailor* once, there[^s1], and here.\n\n[^s1]: A source.\n\n    And more.');
    expect(r.comments).toEqual([
      { body: 'Is *this* right?', author: null, date: null, quote: { exact: 'a sailor', prefix: 'He was ', suffix: ' once, there, and here.' } },
      { body: 'About it all.', author: 'Ada', date: null, quote: null },
    ]);
    // An anchor in pieces (its words change formatting): one footnote, after its last; a comment on all its words.
    const split = anchorNotes('At [the ](scrivcmt://F-1)[**harbour**](scrivcmt://F-1) and [by ](scrivcmt://C-1)*[sea](scrivcmt://C-1)*.', notes);
    expect(split.text).toBe('At the **harbour**[^s1] and by *sea*.\n\n[^s1]: A source.\n\n    And more.');
    expect(split.comments[0]).toMatchObject({ quote: { exact: 'by sea', prefix: 'At the harbour and ', suffix: '.' } });
  });

  it('becomes folders and documents in the binder’s order, a document with documents under it a folder with its text first, with the Draft’s compile settings, research files and notes', async () => {
    const id = (n: number) => String(n);
    const files = new Map<string, Uint8Array>([
      ['Coast.scrivx', enc(SCRIVX(id, 'ID'))],
      ['Files/Docs/2.rtf', enc('Chapter text with [a note](scrivcmt://N-1) and [a source](scrivcmt://N-2).')],
      ['Files/Docs/2.links', enc('<Links><CommentsAndFootnotes><Comment IsFootnote="No" ID="N-1"><RTF>Check this.</RTF></Comment><Comment IsFootnote="Yes" ID="N-2"><RTF>Tide tables, 1902.</RTF></Comment></CommentsAndFootnotes></Links>')],
      ['Files/ProjectNotes/index.xml', enc('<ProjectNotes><Note ID="7"><Title>Ideas</Title></Note><Note ID="8"><Title>Empty</Title></Note></ProjectNotes>')],
      ['Files/ProjectNotes/7.rtf', enc('A book about the sea.')],
      ['Files/Docs/2_synopsis.txt', enc('They arrive.\n')],
      ['Files/Docs/2_notes.rtf', enc('Check the tides.')],
      ['Files/Docs/3.rtf', enc('The quay at night.')],
      ['Files/Docs/4.rtf', enc('')],
      ['Files/Docs/6.pdf', new Uint8Array([37, 80, 68, 70])],
      ['Files/Docs/11.rtf', enc('Trashed.')],
    ]);
    const progress: number[] = [];
    const { folder, left } = await planScrivener(readProject(SCRIVX(id, 'ID')), 'Coast', files, fakeConvert, { snapshots: true, progress: (d) => progress.push(d) });
    expect(progress).toHaveLength(7);
    const me = 'a'.repeat(64);
    const w = writePlan(folder, '', [], { id: me, name: 'Ada' });
    expect(w).toMatchObject({ comments: 1, commentsLeft: 0 });
    const at = (p: string) => `The Coast/${p}`;
    expect(w.files.map((f) => f.path).sort()).toEqual([
      at('.kuraa-order'),
      at('Manuscript/.kuraa-compile.yml'), at('Manuscript/.kuraa-order'),
      at('Manuscript/Chapter One/.kuraa-compile.yml'), at('Manuscript/Chapter One/.kuraa-order'),
      at('Manuscript/Chapter One/chapter-one.md'), at(`Manuscript/Chapter One/chapter-one.md.annotations/@${me}.jsonld`), at('Manuscript/Chapter One/cut-scene.md'), at('Manuscript/Chapter One/the-quay.md'),
      at('Notes/.kuraa-order'), at('Notes/chapter-one.md'), at('Notes/ideas.md'),
      at('Research/.kuraa-order'), at('Research/tide-tables.pdf'),
    ].sort());
    expect(text(w.files, at('Manuscript/Chapter One/chapter-one.md'))).toBe('---\nsynopsis: They arrive.\nlabel: Plot\nstatus: First Draft\nkeywords:\n  - sea\n---\n\nChapter text with a note and a source[^s1].\n\n[^s1]: Tide tables, 1902.\n');
    const page = readPage(text(w.files, at(`Manuscript/Chapter One/chapter-one.md.annotations/@${me}.jsonld`)) ?? null);
    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({ type: 'Annotation', motivation: 'commenting', creator: { id: `urn:kuraa:person:${me}`, name: 'Ada' }, body: { value: 'Check this.' }, target: { source: '../chapter-one.md', selector: [{ type: 'TextQuoteSelector', exact: 'a note' }] }, generator: { name: 'Scrivener' } });
    expect(writePlan(folder, '', [], null)).toMatchObject({ comments: 0, commentsLeft: 1 });
    expect(text(w.files, at('Manuscript/Chapter One/.kuraa-order'))).toMatch(/\nchapter-one\.md\nthe-quay\.md\ncut-scene\.md\n$/);
    expect(text(w.files, at('Manuscript/Chapter One/.kuraa-compile.yml'))).toMatch(/exclude:\n {2}- cut-scene\.md/);
    expect(text(w.files, at('Manuscript/.kuraa-compile.yml'))).toMatch(/title: The Coast\nauthor: Ada Byron\ntarget-words: 80000/);
    expect(text(w.files, at('.kuraa-order'))).toMatch(/\nManuscript\nResearch\nNotes\n$/);
    expect(text(w.files, at('Notes/chapter-one.md'))).toBe('---\ntitle: Chapter One\n---\n\nCheck the tides.\n');
    expect(text(w.files, at('Notes/ideas.md'))).toBe('---\ntitle: Ideas\n---\n\nA book about the sea.\n');
    expect(text(w.files, at('Notes/.kuraa-order'))).toMatch(/\nideas\.md\nchapter-one\.md\n$/);
    expect(left).toEqual(['1 item in Scrivener’s Trash', '1 web page kept in the project in a way that cannot be brought', 'snapshots (earlier versions Scrivener kept)']);
  });
});
