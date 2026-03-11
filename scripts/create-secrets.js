/**
 * Postinstall script:
 * 1. Creates electron/secrets.ts from electron/secrets.example.ts if it does not exist.
 * 2. Configures core.hooksPath to use .githooks/ for cross-worktree hook support.
 *
 * This ensures fresh clones always compile immediately after `yarn install`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const examplePath = path.join(rootDir, 'electron', 'secrets.example.ts');
const secretsPath = path.join(rootDir, 'electron', 'secrets.ts');

if (fs.existsSync(secretsPath)) {
  console.log('[postinstall] electron/secrets.ts already exists — skipping.');
} else {
  if (!fs.existsSync(examplePath)) {
    console.error(
      '[postinstall] ERROR: electron/secrets.example.ts not found. ' +
      'Restore the file from version control before running yarn install.'
    );
    process.exit(1);
  }
  fs.copyFileSync(examplePath, secretsPath);
  console.log('[postinstall] Created electron/secrets.ts from secrets.example.ts.');
  console.log(
    '[postinstall] Fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in electron/secrets.ts when using a custom OAuth client (see secrets.example.ts).'
  );
}

// Configure git hooks path to use versioned .githooks/ directory.
// This ensures hooks work in worktrees (where $GIT_DIR differs from .git/).
try {
  const currentHooksPath = execSync('git config --get core.hooksPath', {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  if (currentHooksPath === '.githooks') {
    console.log('[postinstall] core.hooksPath already set to .githooks — skipping.');
  } else {
    execSync('git config core.hooksPath .githooks', { cwd: rootDir, stdio: 'inherit' });
    console.log('[postinstall] Set core.hooksPath to .githooks (was: ' + currentHooksPath + ').');
  }
} catch {
  // core.hooksPath not set — set it now
  try {
    execSync('git config core.hooksPath .githooks', { cwd: rootDir, stdio: 'inherit' });
    console.log('[postinstall] Set core.hooksPath to .githooks.');
  } catch (configError) {
    console.warn('[postinstall] Warning: Could not set core.hooksPath — not a git repo or git not available.');
  }
}
