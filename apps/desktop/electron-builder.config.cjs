// Packages the app (pnpm --filter @kuraa/desktop dist:mac, dist:win, dist:linux).
// build/ holds everything it runs (build.mjs), so no node_modules are packaged;
// the git it ships goes beside it, in its resources (scripts/fetch-git.mjs).
//
// macOS signing: electron-builder signs with the "Developer ID Application"
// certificate in the keychain (or CSC_LINK / CSC_KEY_PASSWORD). It notarizes when
// Apple credentials are in the environment: APPLE_KEYCHAIN_PROFILE (made with
// `xcrun notarytool store-credentials`), or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD
// and APPLE_TEAM_ID, or APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER.
//
// Updates (decision 0051): KURAA_UPDATES says where the app looks for newer
// releases, and where release:* publishes them: `github:<owner>/<repo>` (GitHub
// Releases; publishing needs GH_TOKEN, and makes a draft release, to publish
// once every platform's build is in it), or an https URL (a folder on any web
// server, holding what dist/ has: the builds, their .blockmap files and
// latest*.yml). Without it, the app built does not update itself.
//
// Windows signing: with Azure Trusted Signing, on Windows, when its account is
// in the environment: AZURE_SIGNING_ENDPOINT (the account's region endpoint),
// AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE (the certificate profile), and
// WIN_PUBLISHER_NAME (exactly as in the certificate), with the credentials of
// an Entra app allowed to sign (AZURE_TENANT_ID, AZURE_CLIENT_ID,
// AZURE_CLIENT_SECRET). The installed app then takes only updates signed by the
// same publisher. Without them, the build is not signed.
/* global module, process */
const notarize = !!(process.env.APPLE_KEYCHAIN_PROFILE || process.env.APPLE_ID || (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID));

/** Azure Trusted Signing, when its account is in the environment; null: not signed. */
function windowsSigning() {
  const e = process.env;
  if (!e.AZURE_SIGNING_ENDPOINT) return null;
  for (const k of ['AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE', 'WIN_PUBLISHER_NAME']) {
    if (!e[k]) throw new Error(`Signing for Windows needs ${k} too`);
  }
  return {
    publisherName: e.WIN_PUBLISHER_NAME,
    endpoint: e.AZURE_SIGNING_ENDPOINT,
    codeSigningAccountName: e.AZURE_SIGNING_ACCOUNT,
    certificateProfileName: e.AZURE_SIGNING_PROFILE,
  };
}

/** Where updates are, from KURAA_UPDATES; null: nowhere. */
function updates() {
  const where = (process.env.KURAA_UPDATES || '').trim();
  if (!where) return null;
  const gh = /^github:([\w.-]+)\/([\w.-]+)$/.exec(where);
  if (gh) return [{ provider: 'github', owner: gh[1], repo: gh[2], releaseType: 'draft' }];
  if (/^https:\/\//.test(where)) return [{ provider: 'generic', url: where }];
  throw new Error(`KURAA_UPDATES should be github:<owner>/<repo> or an https URL, not "${where}"`);
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'org.kuraa.desktop',
  // The name people see (the app's menu, its window, Kuraa.app). Its data stays in the folder it always had
  // (main.ts keeps userData at .../kuraa), and the package and program names stay lowercase.
  productName: 'Kuraa',
  copyright: 'Kuraa',
  // What Electron calls the app; the repo's own runs stay apart.
  // desktopName lets Linux desktops match the running window to its launcher.
  extraMetadata: { name: 'kuraa', productName: 'Kuraa', desktopName: 'kuraa.desktop' },
  directories: { output: 'dist', buildResources: 'build-resources' },
  publish: updates(),
  // Each platform adds its own native addons (below): ${platform} here would be the one building.
  files: ['package.json', 'build/**', '!build/native/**'],
  // Native addons are loaded from files, not from inside the archive.
  asarUnpack: ['build/native/**'],
  extraResources: [
    { from: 'vendor/git/${os}-${arch}', to: 'git', filter: ['**/*', '!.kuraa-git'] },
    // Markdown rendered without Podman (decision 0107): pandoc.wasm for every platform, Typst for this one, with their licences.
    { from: 'vendor/render/pandoc', to: 'render/pandoc' },
    { from: 'vendor/render/${os}-${arch}', to: 'render/typst' },
  ],
  electronFuses: {
    // git-remote-kuraa runs the app as Node (ELECTRON_RUN_AS_NODE): devices fetch from each other through it.
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  },
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.productivity',
    hardenedRuntime: true,
    entitlements: 'build-resources/entitlements.mac.plist',
    entitlementsInherit: 'build-resources/entitlements.mac.plist',
    notarize,
    files: ['build/native/darwin-${arch}/**'],
    artifactName: '${productName}-${version}-mac-${arch}.${ext}',
  },
  // The dmg is for installing; updates on macOS come from the zip, so the dmg needs no blockmap.
  dmg: { artifactName: '${productName}-${version}-mac-${arch}.${ext}', writeUpdateInfo: false },
  // An installer for this user alone (no administrator), which updates are put in place with.
  // (A portable .exe cannot update itself.)
  win: { target: [{ target: 'nsis', arch: ['x64'] }], files: ['build/native/win32-${arch}/**'], azureSignOptions: windowsSigning() },
  nsis: { oneClick: true, perMachine: false, artifactName: '${productName}-${version}-windows-${arch}-setup.${ext}' },
  // Linux: an AppImage, which runs on most distributions as it is, and packages for the two
  // families most use, which install through the system's own tool (no FUSE needed), put kuraa in
  // the app menu, and set up Chromium's sandbox for the system (an AppArmor profile on Ubuntu 24+).
  // Each updates itself: a package through dpkg or rpm, asking for an administrator's password.
  // git is in the app (its resources), so the packages need no git from the system.
  linux: {
    target: ['AppImage', 'deb', 'rpm'].map((target) => ({ target, arch: ['x64', 'arm64'] })),
    category: 'Office',
    syncDesktopName: true,
    files: ['build/native/linux-${arch}/**'],
    artifactName: '${productName}-${version}-linux-${arch}.${ext}',
    // The program stays `kuraa` (its path in /opt, the menu's launcher, scripts that run it).
    executableName: 'kuraa',
    maintainer: 'Kuraa',
  },
  deb: {
    packageCategory: 'editors',
    // electron-builder's own list, and ALSA, which Electron needs to start (a desktop has it; a
    // minimal system may not). Ubuntu 24.04 calls it libasound2t64.
    depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0', 'libasound2t64 | libasound2'],
  },
  // gzip: rpmbuild 4.18 (Debian 12, Ubuntu 24.04: where releases are built) fails, saying nothing,
  // with electron-builder's xz on many threads (and it gives xz only so). Electron barely compresses anyway.
  rpm: { packageCategory: 'Applications/Editors', compression: 'gzip' },
};
