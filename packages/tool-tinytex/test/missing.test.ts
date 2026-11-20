// Reading what a failed LaTeX run lacked from its log (missing.ts), and the
// names the installer is given (validPart).
import { describe, expect, it } from 'vitest';
import { missingParts, tinytex, validPart } from '../src/index.js';

describe('what a LaTeX log says is missing', () => {
  it('names the package for a .sty the map knows, and the file otherwise', () => {
    const log = [
      'processing file: paper.Rmd',
      "! LaTeX Error: File `tcolorbox.sty' not found.",
      '',
      "Type X to quit or <RETURN> to proceed,",
      "! LaTeX Error: File `fancyquotes.sty' not found.",
      "! LaTeX Error: File `tcolorbox.sty' not found.",
      'Error: LaTeX failed to compile document.tex.',
    ].join('\n');
    expect(missingParts(log)).toEqual(['tcolorbox', 'fancyquotes.sty']);
  });

  it('reads document classes, encodings and language files', () => {
    expect(missingParts("! LaTeX Error: File `scrartcl.cls' not found.")).toEqual(['koma-script']);
    expect(missingParts("! LaTeX Error: File `jss.cls' not found.")).toEqual(['jss.cls']);
    expect(missingParts("! Package fontenc Error: Encoding file `t2aenc.def' not found.")).toEqual(['cyrillic']);
    expect(missingParts("! Package babel Error: Unknown option 'french'. Either you misspelled it\n(babel)                or the language definition file french.ldf was not found.")).toEqual(['babel-french']);
    expect(missingParts("! I can't find file `pgfplots.sty'.")).toEqual(['pgfplots']);
  });

  it('reads fonts: metrics, bitmaps, and fonts fontspec looks for by name', () => {
    expect(missingParts('! Font \\T1/cmr/m/n/10=ecrm1000 at 10.0pt not loadable: Metric (TFM) file not found.')).toEqual(['ecrm1000.tfm']);
    expect(missingParts("mktexpk: don't know how to create bitmap font for rsfs10.")).toEqual(['rsfs10.mf']);
    expect(missingParts('! Package fontspec Error: The font "TeX Gyre Pagella" cannot be found.')).toEqual(['font:TeX Gyre Pagella']);
    expect(missingParts('! The font "Fira Sans" cannot be found.')).toEqual(['font:Fira Sans']);
  });

  it('leaves out what TeX Live does not provide and what could reach a command', () => {
    // The document's own files.
    expect(missingParts("! LaTeX Error: File `chapter1.tex' not found.")).toEqual([]);
    expect(missingParts("! LaTeX Error: File `data/table.csv' not found.")).toEqual([]);
    // A document can print anything into the log.
    expect(missingParts("! LaTeX Error: File `$(curl evil).sty' not found.")).toEqual([]);
    expect(missingParts("! LaTeX Error: File `-rf.sty' not found.")).toEqual([]);
    expect(missingParts('! The font "x\\"; rm -rf /" cannot be found.')).toEqual([]);
    // At most twenty.
    const many = Array.from({ length: 50 }, (_, i) => `! LaTeX Error: File \`pkg${i}.sty' not found.`).join('\n');
    expect(missingParts(many)).toHaveLength(20);
  });

  it('accepts as names only packages, files and fonts of plain shapes', () => {
    for (const ok of ['tcolorbox', 'babel-french', 'koma-script', 'foo.sty', 'jss.cls', 'font:TeX Gyre Pagella']) expect(validPart(ok), ok).toBe(true);
    for (const bad of ['', '-x', '../x.sty', 'a b', 'x.sh', 'font:', 'font:$(x)', 'context.x86_64-linux', 'a,b']) expect(validPart(bad), bad).toBe(false);
    expect(tinytex.parts!.valid).toBe(validPart);
  });

  it('gives the installer only checked names, separated by commas, in a variable', () => {
    const view = { workspace: '/work', scratch: '/scratch', files: '/kuraa', inside: (p: string) => p, outside: (p: string) => p };
    const cmd = tinytex.parts!.add(view, { arch: 'aarch64', names: ['tcolorbox', 'foo.sty', 'bad name;', 'font:Fira Sans'] });
    expect(cmd.argv).toEqual(['sh', '/kuraa/add.sh']);
    expect(cmd.env).toEqual({ KURAA_TARGET: '/opt/kuraa/tools/tinytex', KURAA_NAMES: 'tcolorbox,foo.sty,font:Fira Sans' });
    expect(tinytex.path('aarch64')).toEqual(['/opt/kuraa/tools/tinytex/bin/aarch64-linux']);
  });
});
