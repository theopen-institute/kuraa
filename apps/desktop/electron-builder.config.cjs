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
  productName: 'kuraa',
  copyright: 'kuraa',
  // What Electron calls the app (and so where it keeps its data); the repo's own runs stay apart.
  // desktopName lets Linux desktops match the running window to its launcher.
  extraMetadata: { name: 'kuraa', productName: 'kuraa', desktopName: 'kuraa.desktop' },
  directories: { output: 'dist', buildResources: 'build-resources' },
  publish: updates(),
  // Each platform adds its own native addons (below): ${platform} here would be the one building.
  files: ['package.json', 'build/**', '!build/native/**'],
  // Native addons are loaded from files, not from inside the archive.
  asarUnpack: ['build/native/**'],
  extraResources: [{ from: 'vendor/git/${os}-${arch}', to: 'git', filter: ['**/*', '!.kuraa-git'] }],
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
  dmg: { artifactName: '${productName}-${version}-mac-${arch}.${ext}' },
  // An installer for this user alone (no administrator), which updates are put in place with.
  // (A portable .exe cannot update itself.)
  win: { target: [{ target: 'nsis', arch: ['x64'] }], files: ['build/native/win32-${arch}/**'], azureSignOptions: windowsSigning() },
  nsis: { oneClick: true, perMachine: false, artifactName: '${productName}-${version}-windows-${arch}-setup.${ext}' },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'Office',
    syncDesktopName: true,
    files: ['build/native/linux-${arch}/**'],
    artifactName: '${productName}-${version}-linux-${arch}.${ext}',
  },
};
