/**
 * Postinstall script: creates electron/secrets.ts from electron/secrets.example.ts
 * if it does not already exist.
 *
 * This ensures fresh clones always compile immediately after `yarn install`.
 * If secrets.ts already exists (developer has filled in the real secret),
 * it is left untouched.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const examplePath = path.join(rootDir, 'electron', 'secrets.example.ts');
const secretsPath = path.join(rootDir, 'electron', 'secrets.ts');

if (fs.existsSync(secretsPath)) {
  console.log('[create-secrets] electron/secrets.ts already exists — skipping.');
} else {
  if (!fs.existsSync(examplePath)) {
    console.error(
      '[create-secrets] ERROR: electron/secrets.example.ts not found. ' +
      'Restore the file from version control before running yarn install.'
    );
    process.exit(1);
  }
  fs.copyFileSync(examplePath, secretsPath);
  console.log('[create-secrets] Created electron/secrets.ts from secrets.example.ts.');
  console.log('[create-secrets] Replace the empty GOOGLE_CLIENT_SECRET value with your real secret from Google Cloud Console.');
}
