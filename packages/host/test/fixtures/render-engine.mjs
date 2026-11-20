// An engine component that renders documents, as a third party would write one:
// plain JavaScript. It "renders" Markdown by starting a process through the
// environment it is given (the test environments report what they were asked)
// and writing what it read and was told into scratch. A document that says
// FAIL fails, SLOW takes longer than the time allowed, and LINK leaves a link
// where its output should be, as code in a document could.
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); });
});

export default {
  apiVersion: 1,
  name: 'render-engine',
  engines: [{
    id: 'paper',
    label: 'Paper',
    handles: ['paper'],
    open() {
      throw new Error('Paper runs no chunks.');
    },
    render: {
      extensions: ['.md'],
      formats: ['html', 'docx'],
      async render(ctx, req) {
        const proc = await ctx.environment.start({
          name: 'render',
          workspace: ctx.workspace, scratch: ctx.scratch, files: ctx.files, policy: ctx.policy,
          command: (view) => ({ argv: ['paper', view.inside(req.input), req.format], cwd: view.scratch }),
          log: ctx.log, status: ctx.status,
        }, ctx.environmentOptions);
        let said = '';
        proc.stdout.setEncoding('utf8');
        for await (const chunk of proc.stdout) said += chunk;
        await proc.exited;
        const text = await readFile(req.input, 'utf8');
        if (text.includes('FAIL')) return { ok: false, message: 'The document could not be rendered: it says FAIL.', log: `paper: line 3: FAIL\n${said}` };
        if (text.includes('SLOW')) {
          await sleep(ctx.timeLimitMs, ctx.signal);
          return { ok: false, message: `The render took longer than ${ctx.timeLimitMs} ms, the most this host allows, and was stopped.`, log: said };
        }
        await mkdir(join(ctx.scratch, 'out'), { recursive: true });
        const out = join(ctx.scratch, 'out', `document.${req.format}`);
        if (text.includes('LINK')) await symlink(req.input, out);
        else await writeFile(out, `<p>${said}</p>\n<pre>${text}</pre>\n`);
        return { ok: true, output: `out/document.${req.format}`, message: `Rendered to ${req.format}.`, log: said };
      },
    },
  }],
};
