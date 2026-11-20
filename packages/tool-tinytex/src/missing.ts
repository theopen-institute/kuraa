// What a failed LaTeX run lacked, read from its log (what rmarkdown, tinytex and
// pandoc print, which includes LaTeX's own error lines).
//
// The answer is a list of names the installer takes (add.sh):
//   tcolorbox              a TeX Live package, where the file is one this map knows
//   foo.sty                a file, which the installer looks up with
//                          `tlmgr search --global --file` (it has the network)
//   font:TeX Gyre Pagella  a font fontspec could not find, looked up the same way
//
// The log is written by people's documents (\typeout can print anything), so
// only names of the shapes `validPart` accepts come out, and at most a few.

/** File types a TeX Live package provides and LaTeX reports missing. */
const FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,80}\.(sty|cls|def|cfg|fd|clo|ldf|tfm|mf|otf|ttf|pfb|bst|bbx|cbx|lbx|dbx|enc|map|code\.tex)$/;
/** A TeX Live package name (arch-specific ones, with a dot, are never asked for). */
const PACKAGE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
/** A font's name, as fontspec reports it. */
const FONT = /^font:[A-Za-z0-9][A-Za-z0-9 _-]{0,60}$/;
/** The most names one log gives. */
const MAX = 20;

export function validPart(name: string): boolean {
  return FILE.test(name) || PACKAGE.test(name) || FONT.test(name);
}

/**
 * Files whose package is not simply named after them, and common ones, so
 * that a message can name the package and the installer need not search.
 */
const KNOWN: Record<string, string> = {
  'tikz.sty': 'pgf', 'pgf.sty': 'pgf', 'pgfcore.sty': 'pgf', 'pgfkeys.sty': 'pgf', 'pgffor.sty': 'pgf', 'xxcolor.sty': 'pgf',
  'pgfplots.sty': 'pgfplots', 'tcolorbox.sty': 'tcolorbox', 'tikzfill.image.sty': 'tikzfill', 'environ.sty': 'environ', 'trimspaces.sty': 'trimspaces',
  'amssymb.sty': 'amsfonts', 'amsfonts.sty': 'amsfonts', 'amsthm.sty': 'amscls', 'amsmath.sty': 'amsmath', 'mathtools.sty': 'mathtools',
  'framed.sty': 'framed', 'fancyhdr.sty': 'fancyhdr', 'titlesec.sty': 'titlesec', 'titling.sty': 'titling', 'booktabs.sty': 'booktabs',
  'float.sty': 'float', 'caption.sty': 'caption', 'subcaption.sty': 'caption', 'multirow.sty': 'multirow', 'wrapfig.sty': 'wrapfig',
  'colortbl.sty': 'colortbl', 'pdflscape.sty': 'pdflscape', 'tabu.sty': 'tabu', 'threeparttable.sty': 'threeparttable',
  'threeparttablex.sty': 'threeparttablex', 'ulem.sty': 'ulem', 'makecell.sty': 'makecell', 'xltabular.sty': 'xltabular',
  'mdframed.sty': 'mdframed', 'needspace.sty': 'needspace', 'zref-abspage.sty': 'zref', 'zref-base.sty': 'zref', 'lineno.sty': 'lineno',
  'setspace.sty': 'setspace', 'soul.sty': 'soul', 'xurl.sty': 'xurl', 'bookmark.sty': 'bookmark', 'footnotehyper.sty': 'footnotehyper',
  'etoolbox.sty': 'etoolbox', 'geometry.sty': 'geometry', 'upquote.sty': 'upquote', 'microtype.sty': 'microtype', 'parskip.sty': 'parskip',
  'fvextra.sty': 'fvextra', 'fancyvrb.sty': 'fancyvrb', 'listings.sty': 'listings', 'biblatex.sty': 'biblatex', 'csquotes.sty': 'csquotes',
  'natbib.sty': 'natbib', 'unicode-math.sty': 'unicode-math', 'fontspec.sty': 'fontspec', 'selnolig.sty': 'selnolig', 'siunitx.sty': 'siunitx',
  'epstopdf.sty': 'epstopdf-pkg', 'grffile.sty': 'grffile', 'kvoptions.sty': 'kvoptions', 'xcolor.sty': 'xcolor', 'enumitem.sty': 'enumitem',
  'hyperref.sty': 'hyperref', 'longtable.sty': 'tools', 'array.sty': 'tools', 'tabularx.sty': 'tools', 'multicol.sty': 'tools',
  'fontawesome5.sty': 'fontawesome5', 'fontawesome.sty': 'fontawesome', 'lastpage.sty': 'lastpage', 'tocloft.sty': 'tocloft',
  'appendix.sty': 'appendix', 'pdfpages.sty': 'pdfpages', 'eso-pic.sty': 'eso-pic', 'textpos.sty': 'textpos', 'ragged2e.sty': 'ragged2e',
  'sectsty.sty': 'sectsty', 'adjustbox.sty': 'adjustbox', 'collectbox.sty': 'collectbox', 'chngcntr.sty': 'chngcntr',
  'cleveref.sty': 'cleveref', 'placeins.sty': 'placeins', 'svg.sty': 'svg', 'transparent.sty': 'transparent', 'xstring.sty': 'xstring',
  'lipsum.sty': 'lipsum', 'blindtext.sty': 'blindtext', 'dcolumn.sty': 'tools', 'bm.sty': 'tools', 'afterpage.sty': 'tools',
  'ifoddpage.sty': 'ifoddpage', 'awesomebox.sty': 'awesomebox', 'marginnote.sty': 'marginnote', 'sourcesanspro.sty': 'sourcesanspro',
  'sourcecodepro.sty': 'sourcecodepro', 'inconsolata.sty': 'inconsolata', 'tgpagella.sty': 'tex-gyre', 'tgtermes.sty': 'tex-gyre',
  'mathpazo.sty': 'psnfss', 'helvet.sty': 'psnfss', 'times.sty': 'psnfss', 'palatino.sty': 'psnfss', 'newtxtext.sty': 'newtx',
  'newtxmath.sty': 'newtx', 'libertine.sty': 'libertine', 'ebgaramond.sty': 'ebgaramond', 'roboto.sty': 'roboto', 'lato.sty': 'lato',
  'scrartcl.cls': 'koma-script', 'scrreprt.cls': 'koma-script', 'scrbook.cls': 'koma-script', 'scrlttr2.cls': 'koma-script',
  'scrlayer-scrpage.sty': 'koma-script', 'beamer.cls': 'beamer', 'memoir.cls': 'memoir', 'elsarticle.cls': 'elsarticle',
  'IEEEtran.cls': 'ieeetran', 'revtex4-2.cls': 'revtex', 'apa7.cls': 'apa7', 'apa6.cls': 'apa6', 'llncs.cls': 'llncs', 'acmart.cls': 'acmart',
  'moderncv.cls': 'moderncv', 'tufte-handout.cls': 'tufte-latex', 'tufte-book.cls': 'tufte-latex',
  'french.ldf': 'babel-french', 'frenchb.ldf': 'babel-french', 'german.ldf': 'babel-german', 'ngerman.ldf': 'babel-german',
  'spanish.ldf': 'babel-spanish', 'portuges.ldf': 'babel-portuges', 'portuguese.ldf': 'babel-portuges', 'brazil.ldf': 'babel-portuges',
  'italian.ldf': 'babel-italian', 'dutch.ldf': 'babel-dutch', 'swedish.ldf': 'babel-swedish', 'norsk.ldf': 'babel-norsk',
  'danish.ldf': 'babel-danish', 'finnish.ldf': 'babel-finnish', 'polish.ldf': 'babel-polish', 'russianb.ldf': 'babel-russian',
  'greek.ldf': 'babel-greek', 'catalan.ldf': 'babel-catalan', 'czech.ldf': 'babel-czech', 'turkish.ldf': 'babel-turkish',
  't2aenc.def': 'cyrillic', 'lgrenc.def': 'greek-fontenc',
};

/** The packages the map knows, and the files it does not, from a list of file names. */
function named(file: string): string {
  return KNOWN[file] ?? file;
}

/** What the log says was missing, as names for the installer: packages where known, else files and fonts. */
export function missingParts(log: string): string[] {
  const out = new Set<string>();
  const add = (name: string) => {
    if (out.size < MAX && validPart(name)) out.add(name);
  };
  const file = (f: string) => {
    const name = f.trim();
    // Documents' own files (chapter.tex, data/x.csv) are not TeX Live's to provide.
    if (FILE.test(name)) add(named(name));
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    for (const m of log.matchAll(re)) fn(m);
  };
  // ! LaTeX Error: File `tcolorbox.sty' not found.   ! Package fontenc Error: Encoding file `t2aenc.def' not found.
  each(/[Ff]ile `([^'`\n]{1,100})' not found/g, (m) => file(m[1]!));
  // ! I can't find file `foo.sty'.
  each(/! I can't find file `([^'`\n]{1,100})'/g, (m) => file(m[1]!));
  // ! Font \T1/cmr/m/n/10=ecrm1000 at 10.0pt not loadable: Metric (TFM) file not found.
  each(/! Font [^=\n]{1,100}=([A-Za-z0-9_-]{1,60})(?: at [^\n]{1,20})? not loadable: Metric \(TFM\) file/g, (m) => file(`${m[1]}.tfm`));
  // mktexpk: don't know how to create bitmap font for ecrm1000.
  each(/(?:mktexpk|mktextfm|kpathsea): don't know how to create bitmap font for ([A-Za-z0-9_-]{1,60})/g, (m) => file(`${m[1]}.mf`));
  each(/kpathsea: Running mktextfm ([A-Za-z0-9_-]{1,60})/g, (m) => file(`${m[1]}.tfm`));
  // ! Package babel Error: Unknown option 'french'. Either you misspelled it or the language definition file french.ldf was not found.
  each(/language definition file ([A-Za-z0-9_-]{1,40}\.ldf) was not found/g, (m) => file(m[1]!));
  // ! Package fontspec Error: The font "TeX Gyre Pagella" cannot be found.   (xelatex: ! The font "X" cannot be found.)
  each(/The font "([^"\n]{1,60})" cannot be found/g, (m) => add(`font:${m[1]!.trim()}`));
  // luaotfload: ... Font "X" not found.
  each(/luaotfload[^\n]{0,80}Font "([^"\n]{1,60})" not found/g, (m) => add(`font:${m[1]!.trim()}`));
  return [...out];
}
