/**
 * run-electron-tests.js
 *
 * Launcher script for the backend E2E test suite.
 *
 * Problem: Claude's tool environment sets ELECTRON_RUN_AS_NODE=1, which causes
 * Electron to behave as a plain Node.js process (no Chromium, no BrowserWindow).
 * The tests require a real Electron process with a hidden BrowserWindow for IPC.
 *
 * Solution: spawn Electron as a child process with ELECTRON_RUN_AS_NODE explicitly
 * deleted from the inherited environment, then forward stdout/stderr and exit code.
 */

'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');

// Set console code page to UTF-8 on Windows for proper Mocha symbol rendering
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {
    // Ignore errors (e.g., if chcp is unavailable)
  }
}

const electronBin = require('electron');
const testEntry = path.join(__dirname, '..', 'dist-test', 'tests', 'backend', 'test-main.js');

// Build a clean environment: inherit everything EXCEPT ELECTRON_RUN_AS_NODE
const cleanEnv = Object.assign({}, process.env);
delete cleanEnv['ELECTRON_RUN_AS_NODE'];

const child = spawn(String(electronBin), [testEntry], {
  env: cleanEnv,
  stdio: 'inherit',
});

child.on('close', (code) => {
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error('[run-electron-tests] Failed to launch Electron:', error.message);
  process.exit(1);
});
