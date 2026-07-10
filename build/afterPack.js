'use strict';

// electron-builder afterPack hook: runs after the app is packaged but BEFORE
// code signing. Strips macOS extended attributes (e.g. com.apple.provenance)
// that get added to freshly extracted Electron files and cause codesign to
// fail with "resource fork, Finder information, or similar detritus not allowed".

const { execFileSync } = require('child_process');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${appName}.app`;

  try {
    execFileSync('xattr', ['-cr', appPath], { stdio: 'ignore' });
    console.log(`\n  • Cleared extended attributes on ${appName}.app before signing\n`);
  } catch (err) {
    console.warn(`\n  • Warning: could not clear extended attributes: ${err.message}\n`);
  }
};
