// Builds the server as released (decision 0052): kuraa-host (packages/server/src/
// release.ts: one program, a host or, with `server`, a server, 0099) bundled into
// one file, with the web client beside it, and
// Hyperswarm's native parts for every platform it ships on, in one folder that
// needs only Node 24 and git; then that folder as an archive and, with the
// release key, its signature. (Its checksum is the one GitHub lists for it.)
//
//   node scripts/build-server.mjs       → dist/server/kuraa-server-<version>.tar.gz
//                                         (and .sig, with SERVER_SIGNING_KEY)
//
// The version is the app's (apps/desktop/package.json). KURAA_UPDATES
// (github:<owner>/<repo>) is where the server looks for newer releases;
// SERVER_SIGNING_KEY (an Ed25519 private key, PEM: scripts/server-signing-key.mjs
// makes one) signs the archive, and its public half is built in, so the server
// takes only updates signed with it. Build the web client first (pnpm web:build).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');
const NATIVE = ['sodium-native', 'udx-native'];
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'];

const version = JSON.parse(readFileSync(join(ROOT, 'apps/desktop/package.json'), 'utf8')).version;
const where = (process.env.KURAA_UPDATES || '').trim();
const gh = /^github:([\w.-]+\/[\w.-]+)$/.exec(where);
if (where && !gh) throw new Error(`KURAA_UPDATES should be github:<owner>/<repo> for the server, not "${where}"`);
const key = process.env.SERVER_SIGNING_KEY ? createPrivateKey(process.env.SERVER_SIGNING_KEY) : null;
if (key && key.asymmetricKeyType !== 'ed25519') throw new Error('SERVER_SIGNING_KEY should be an Ed25519 private key');
// A release servers update to (KURAA_UPDATES) is signed, or not made: unsigned, a server would take any archive matching GitHub's checksum (0099).
if (gh && !key) throw new Error('KURAA_UPDATES names where servers update from, so SERVER_SIGNING_KEY must sign the release');
const publicKey = key ? createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString() : null;

const web = join(ROOT, 'apps/web/dist');
if (!existsSync(join(web, 'index.html'))) throw new Error('Build the web client first: pnpm web:build');

const out = join(ROOT, 'dist/server');
const name = `kuraa-server-${version}`;
const dir = join(out, name);
rmSync(out, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

/** Where a native package is, as Hyperswarm finds it (through hyperdht). */
function packageDir(pkg) {
  const host = createRequire(join(ROOT, 'packages/host/package.json'));
  return dirname(createRequire(host.resolve('hyperdht')).resolve(`${pkg}/package.json`));
}

// Native addons load from native/<platform>-<arch>/ beside the bundle, as in the desktop app.
const nativeAddons = {
  name: 'native-addons',
  setup(b) {
    b.onLoad({ filter: new RegExp(`[\\\\/](${NATIVE.join('|')})[\\\\/]binding\\.js$`) }, (args) => {
      const pkg = NATIVE.find((n) => args.path.includes(n));
      return { loader: 'js', contents: `module.exports = require(require('node:path').join(__dirname, 'native', process.platform + '-' + process.arch, ${JSON.stringify(`${pkg}.node`)}));` };
    });
  },
};

await build({
  entryPoints: [join(ROOT, 'packages/server/src/release.ts')],
  outfile: join(dir, 'kuraa-host.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: 'linked',
  logLevel: 'warning',
  plugins: [nativeAddons],
  define: { __KURAA_SERVER__: JSON.stringify({ version, repo: gh ? gh[1] : null, publicKey }) },
  // CommonJS dependencies, in an ES module: require, __dirname and __filename as they expect.
  banner: {
    js: [
      "import { createRequire as __kuraaRequire } from 'node:module';",
      "import { fileURLToPath as __kuraaPath } from 'node:url';",
      "import { dirname as __kuraaDir } from 'node:path';",
      'const require = __kuraaRequire(import.meta.url);',
      'const __filename = __kuraaPath(import.meta.url);',
      'const __dirname = __kuraaDir(__filename);',
    ].join('\n'),
  },
});
for (const pkg of NATIVE) {
  for (const p of PLATFORMS) {
    const addon = join(packageDir(pkg), 'prebuilds', p, `${pkg}.node`);
    if (!existsSync(addon)) throw new Error(`${pkg} has no build for ${p}`);
    mkdirSync(join(dir, 'native', p), { recursive: true });
    cpSync(addon, join(dir, 'native', p, `${pkg}.node`));
  }
}
cpSync(web, join(dir, 'web'), { recursive: true });
writeFileSync(join(dir, 'VERSION'), `${version}\n`);
// The Node it needs: a server does not switch to a release its Node cannot run (selfupdate.ts).
writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'kuraa-server', version, type: 'module', private: true, engines: { node: '>=24' } }, null, 2)}\n`);

const archive = join(out, `${name}.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', out, name]);
const bytes = readFileSync(archive);
if (key) writeFileSync(`${archive}.sig`, `${sign(null, bytes, key).toString('base64')}\n`);
process.stdout.write(`server: ${archive}${key ? ' (signed)' : ' (not signed: no SERVER_SIGNING_KEY)'}${gh ? `, updating from ${gh[1]}` : ', not updating itself (no KURAA_UPDATES)'}\n`);
