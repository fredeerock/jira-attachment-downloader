'use strict';

const { execFileSync } = require('child_process');

if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
  console.log('Building an explicitly unsigned macOS artifact for local testing.');
  process.exit(0);
}

const missing = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  .filter((name) => !process.env[name]);

if (missing.length > 0) {
  throw new Error(
    `Refusing to build a distributable macOS artifact without notarization credentials: ${missing.join(', ')}. ` +
    'Use npm run dist:mac:unsigned only for local testing.'
  );
}

const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
  encoding: 'utf8'
});

if (!identities.includes('Developer ID Application:')) {
  throw new Error(
    'Refusing to build a distributable macOS artifact: no Developer ID Application certificate was found in the keychain.'
  );
}

console.log('Developer ID signing certificate and notarization credentials found.');