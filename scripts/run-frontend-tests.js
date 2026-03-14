/**
 * run-frontend-tests.js
 *
 * Launcher script for the frontend Playwright Electron test suite.
 *
 * Problem: Claude's tool environment sets ELECTRON_RUN_AS_NODE=1, which causes
 * Electron to behave as a plain Node.js process instead of launching Chromium.
 * Playwright must launch a real Electron app for desktop UI testing.
 *
 * Solution: spawn Playwright as a child process with ELECTRON_RUN_AS_NODE
 * removed from the inherited environment, then forward stdout/stderr and exit code.
 */

'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {
    // Ignore errors (for example if chcp is unavailable)
  }
}

const cleanEnv = Object.assign({}, process.env);
delete cleanEnv['ELECTRON_RUN_AS_NODE'];
cleanEnv['LATENTMAIL_TEST_MODE'] = '1';

const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latentmail-frontend-test-'));
cleanEnv['LATENTMAIL_TEST_TEMP_DIR'] = testTempDir;
fs.writeFileSync(
  path.join(testTempDir, '.frontend-test-owner.json'),
  JSON.stringify({ pid: process.pid, role: 'frontend-test-launcher', createdAt: Date.now() }),
  'utf8',
);

const playwrightBin = path.join(
  __dirname,
  '..',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'playwright.cmd' : 'playwright',
);

const playwrightArgs = [
  'test',
  '--config',
  'dist-test/tests/frontend/playwright.config.js',
  ...process.argv.slice(2),
];

const child = spawn(playwrightBin, playwrightArgs, {
  env: cleanEnv,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

function cleanupTempDir() {
  try {
    fs.rmSync(testTempDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  } catch (error) {
    console.error('[run-frontend-tests] Failed to clean up test temp directory:', testTempDir, error.message);
  }
}

child.on('close', (code) => {
  cleanupTempDir();
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  cleanupTempDir();
  console.error('[run-frontend-tests] Failed to launch Playwright:', error.message);
  process.exit(1);
});
