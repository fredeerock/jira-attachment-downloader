'use strict';

// electron-builder afterSign hook: notarizes the macOS app with Apple.
//
// Requires these environment variables to be set (otherwise notarization is
// skipped so that normal unsigned dev builds still work):
//   APPLE_ID                     - your Apple ID email
//   APPLE_APP_SPECIFIC_PASSWORD  - an app-specific password (appleid.apple.com)
//   APPLE_TEAM_ID                - your 10-character Apple Developer Team ID
//
// Notarization also requires the app to be signed with a
// "Developer ID Application" certificate (installed in your login keychain),
// which comes with a paid Apple Developer Program membership.

const { notarize } = require('@electron/notarize');
const { execFileSync } = require('child_process');

module.exports = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
      console.log('\n  • Skipping notarization for the explicit unsigned build.\n');
      return;
    }

    throw new Error(
      'Cannot create a macOS release without notarization credentials. Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID, or use npm run dist:mac:unsigned for local testing.'
    );
  }

  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    throw new Error('Notarization requires code signing; do not combine Apple credentials with the unsigned build.');
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`\n  • Notarizing ${appName}.app — this can take a few minutes…\n`);

  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID
  });

  execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });

  console.log(`\n  • Notarization complete for ${appName}.app\n`);
};
