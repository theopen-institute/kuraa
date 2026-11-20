// Packages the app (pnpm --filter @kuraa/desktop dist:mac, dist:win, dist:linux).
// build/ holds everything it runs (build.mjs), so no node_modules are packaged;
// the git it ships goes beside it, in its resources (scripts/fetch-git.mjs).
//
// macOS signing: electron-builder signs with the "Developer ID Application"
// certificate in the keychain (or CSC_LINK / CSC_KEY_PASSWORD). It notarizes when
// Apple credentials are in the environment: APPLE_KEYCHAIN_PROFILE (made with
// `xcrun notarytool store-credentials`), or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD
// and APPLE_TEAM_ID, or APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER.
/* global module, process */
const notarize = !!(process.env.APPLE_KEYCHAIN_PROFILE || process.env.APPLE_ID || process.env.APPLE_API_KEY);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'org.kuraa.desktop',
  productName: 'kuraa',
  copyright: 'kuraa',
  // What Electron calls the app (and so where it keeps its data); the repo's own runs stay apart.
  // desktopName lets Linux desktops match the running window to its launcher.
  extraMetadata: { name: 'kuraa', productName: 'kuraa', desktopName: 'kuraa.desktop' },
  directories: { output: 'dist', buildResources: 'build-resources' },
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
  // One .exe that runs where it is: no installer.
  win: { target: [{ target: 'portable', arch: ['x64'] }], files: ['build/native/win32-${arch}/**'] },
  portable: { artifactName: '${productName}-${version}-windows-${arch}.exe' },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'Office',
    syncDesktopName: true,
    files: ['build/native/linux-${arch}/**'],
    artifactName: '${productName}-${version}-linux-${arch}.${ext}',
  },
};
