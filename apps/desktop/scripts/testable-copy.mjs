// A copy of a packaged app that the desktop tests can drive: Playwright talks
// to Electron through the Node inspector, which the packaged app turns off
// (electron-builder.config.cjs, electronFuses). Prints the copy's executable,
// for KURAA_DESKTOP_APP. On macOS the copy is signed again, for this Mac only.
//
//   node scripts/testable-copy.mjs dist/mac-arm64/kuraa.app
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { argv, platform, stdout } from 'node:process';
import { tmpdir } from 'node:os';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';

const app = resolve(argv[2] ?? '');
const copy = join(tmpdir(), `kuraa-testable-${basename(app)}`);
rmSync(copy, { recursive: true, force: true });
cpSync(app, copy, { recursive: true, verbatimSymlinks: true });
const exe = platform === 'darwin' ? join(copy, 'Contents', 'MacOS', basename(app, '.app')) : join(copy, platform === 'win32' ? 'kuraa.exe' : 'kuraa');
await flipFuses(exe, {
  version: FuseVersion.V1,
  [FuseV1Options.EnableNodeCliInspectArguments]: true,
});
// The whole app, signed again for this Mac only (its parts must all carry the same signature).
if (platform === 'darwin') execFileSync('codesign', ['--force', '--deep', '--sign', '-', copy]);
stdout.write(`${exe}\n`);
