// A tool, an environment and a renderer from outside the packages, as a third
// party would write them: plain JavaScript. Nothing is downloaded and nothing
// runs in a container.
//
//   fakepdf   a tool: its installer "installs" by writing bin/fakepdf and
//             parts/base into the folder it is given; it adds parts by writing
//             parts/<name>
//   toolbox   an environment that does what the installer and the renderer ask
//             in plain JavaScript, on the host folders behind the mounts, and
//             reports its architecture (options.arch, default x86_64)
//   typeset   renders .md to PDF; a document saying NEEDS-PDF-TOOL uses
//             fakepdf, and each \usepackage{x} in it needs parts/x, or the
//             "log" says `x.sty' is missing, as LaTeX's does
//
// Every process started is pushed onto globalThis.__toolbox, for the tests.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

const PREFIX = '\u001fkuraa-tool\u001f';
const INSIDE = '/opt/kuraa/tools/fakepdf';
globalThis.__toolbox ??= [];

const tool = {
  id: 'fakepdf',
  label: 'Fake PDF',
  description: 'A tool for the tests.',
  version: '1.0',
  downloadBytes: 12_000_000,
  architectures: ['x86_64', 'aarch64'],
  inside: INSIDE,
  path: (arch) => [`${INSIDE}/bin/${arch}`],
  env: () => ({ FAKE_TEXMFVAR: '/tmp/fake' }),
  installer: {
    image: { containerfile: 'FROM fake-installer\n' },
    files: { 'install.sh': 'echo install\n' },
    install: (view, o) => ({ argv: ['fake-install', o.arch ?? ''], env: { TARGET: INSIDE } }),
  },
  parts: {
    label: 'fake packages',
    record: '.kuraa/fake-packages.json',
    valid: (n) => /^[a-z0-9-]{1,40}(\.sty)?$/.test(n),
    missing: (log) => [...log.matchAll(/File `([a-z0-9-]+)\.sty' not found/g)].map((m) => m[1]),
    add: (view, o) => ({ argv: ['fake-add', ...o.names], env: { TARGET: INSIDE } }),
  },
};

/** A process that has already said what it says. */
function finished(view, out, err = '', code = 0, waitMs = 0) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exited = (async () => {
    for (const piece of [].concat(err)) {
      stderr.write(piece);
      if (waitMs) await sleep(waitMs / 4);
    }
    if (waitMs) await sleep(waitMs);
    // As run-kit asks: ended once what it said has been read.
    const read = (s) => new Promise((resolve) => s.once('end', resolve));
    const both = read(stdout);
    stdout.end(out);
    stderr.end();
    await both;
    return { code, signal: null };
  })();
  return { stdin: new PassThrough(), stdout, stderr, view, interrupt() {}, kill() {}, exited };
}

const environment = {
  id: 'toolbox',
  label: 'in the toolbox',
  sandboxed: true,
  async check(options) {
    return { available: true, message: 'the toolbox is here', arch: options?.arch ?? 'x86_64' };
  },
  async start(req, options) {
    const host = (inside) => req.mounts?.find((m) => inside === m.inside || inside.startsWith(`${m.inside}/`));
    const view = { workspace: '/work', scratch: req.scratch, files: req.files, inside: (p) => p, outside: (p) => p };
    const { argv, env } = req.command(view);
    const call = { argv, env: env ?? {}, mounts: req.mounts ?? [], policy: req.policy, image: req.image };
    globalThis.__toolbox.push(call);
    const target = host(env?.TARGET ?? '');
    const arch = options?.arch ?? 'x86_64';
    if (argv[0] === 'fake-install') {
      if (options?.failInstall) return finished(view, `${PREFIX}${JSON.stringify({ ok: false, message: 'there is no network' })}\n`);
      if (target?.access !== 'read-write') return finished(view, `${PREFIX}{"ok":false,"message":"nowhere to install"}\n`);
      await mkdir(join(target.host, 'bin', arch), { recursive: true });
      await mkdir(join(target.host, 'parts'), { recursive: true });
      await writeFile(join(target.host, 'bin', arch, 'fakepdf'), '#!/bin/sh\n');
      await writeFile(join(target.host, 'parts', 'base'), '');
      return finished(view, `${PREFIX}${JSON.stringify({ ok: true, arch, parts: ['base'] })}\n`, ['Downloading Fake PDF…\n', '####      50.0%\r'], 0, options?.slowMs ?? 0);
    }
    if (argv[0] === 'fake-add') {
      const names = argv.slice(1).map((n) => n.replace(/\.sty$/, ''));
      for (const n of names) await writeFile(join(target.host, 'parts', n), '');
      return finished(view, `${PREFIX}${JSON.stringify({ ok: true, added: names })}\n`, `Adding ${names.join(' ')}…\n`);
    }
    if (argv[0] === 'typeset') {
      const text = await readFile(argv[1], 'utf8');
      const mount = req.mounts?.find((m) => m.inside === INSIDE);
      const lacking = [...text.matchAll(/\\usepackage\{([a-z0-9-]+)\}/g)].map((m) => m[1]).filter((p) => !mount || !existsSync(join(mount.host, 'parts', p)));
      if (lacking.length) return finished(view, lacking.map((p) => `! LaTeX Error: File \`${p}.sty' not found.\n`).join(''), '', 1);
      const said = `typeset with ${mount ? `${mount.inside} (${mount.access})` : 'no tool'}; PATH ${env?.PATH ?? ''}; TEXMFVAR ${env?.FAKE_TEXMFVAR ?? ''}`;
      return finished(view, said, '', 0, text.includes('SLOW') ? 1500 : 0);
    }
    return finished(view, '', `unknown program ${argv[0]}\n`, 127);
  },
};

const engine = {
  id: 'typeset',
  label: 'Typeset',
  handles: ['typeset'],
  open() {
    throw new Error('Typeset runs no chunks.');
  },
  render: {
    extensions: ['.md'],
    formats: ['html', 'pdf'],
    async render(ctx, req) {
      const text = await readFile(req.input, 'utf8');
      const env = {};
      const mounts = [];
      let without = '';
      if (req.format === 'pdf' && text.includes('NEEDS-PDF-TOOL')) {
        const use = ctx.tools ? await ctx.tools.use('fakepdf') : { ok: false, reason: 'No tools here.', canDownload: false };
        if (use.ok) {
          mounts.push(...use.mounts);
          Object.assign(env, use.env, { PATH: use.path.join(':') });
        } else if (use.canDownload) return { ok: false, needs: { tool: 'fakepdf' }, message: `This document needs Fake PDF. ${use.reason}`, log: '' };
        else without = ` ${use.reason}`;
      }
      const proc = await ctx.environment.start({
        name: 'typeset', workspace: ctx.workspace, scratch: ctx.scratch, files: ctx.files, policy: ctx.policy, mounts,
        command: () => ({ argv: ['typeset', req.input], cwd: ctx.scratch, env }),
        log: ctx.log, status: ctx.status,
      }, ctx.environmentOptions);
      let said = '';
      proc.stdout.setEncoding('utf8');
      for await (const chunk of proc.stdout) said += chunk;
      const { code } = await proc.exited;
      if (code !== 0) return { ok: false, message: 'LaTeX failed.', log: said };
      await mkdir(join(ctx.scratch, 'out'), { recursive: true });
      await writeFile(join(ctx.scratch, 'out', `document.${req.format}`), said);
      return { ok: true, output: `out/document.${req.format}`, message: `Rendered to ${req.format}.${without}`, log: said };
    },
  },
};

export default { apiVersion: 1, name: 'test-tools', tools: [tool], environments: [environment], engines: [engine] };
