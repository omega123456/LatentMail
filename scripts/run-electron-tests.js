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
const fs = require('fs');
const os = require('os');
const path = require('path');

// Set console code page to UTF-8 on Windows for proper Mocha symbol rendering
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {
    // Ignore errors (e.g., if chcp is unavailable)
  }
}

// ---- Parse CLI arguments ----
// Supported flags:
//   --filter=<regex>   Filter tests by name (Mocha grep, regex-capable, case-insensitive)
//   --grep=<regex>     Alias for --filter
//   --file=<pattern>   Filter test suite files by filename (substring, case-insensitive)
//   --suite=<pattern>  Alias for --file
//   --list             List all available test suites and exit
//
// Usage examples:
//   yarn test:backend --filter=login
//   yarn test:backend --file=auth
//   yarn test:backend --file=queue --filter="retry"
//   yarn test:backend --list

const cliArgs = process.argv.slice(2);

const listSuites = cliArgs.includes('--list');

function extractFlagValue(flags) {
  for (const flag of flags) {
    const prefix = flag + '=';
    const match = cliArgs.find((argument) => argument.startsWith(prefix));
    if (match !== undefined) {
      return match.slice(prefix.length);
    }
  }
  return undefined;
}

const grepPattern = extractFlagValue(['--filter', '--grep']);
const filePattern = extractFlagValue(['--file', '--suite']);

// ---- --list: print available suites and exit ----
if (listSuites) {
  const suitesSourceDir = path.join(__dirname, '..', 'tests', 'backend', 'suites');
  let suiteFiles;
  try {
    suiteFiles = fs.readdirSync(suitesSourceDir).filter((file) => file.endsWith('.test.ts')).sort();
  } catch {
    console.error('[run-electron-tests] Could not read suites directory:', suitesSourceDir);
    process.exit(1);
  }
  console.log('');
  console.log('Available test suites:');
  console.log('');
  for (const suiteFile of suiteFiles) {
    console.log('  ' + suiteFile.replace('.test.ts', ''));
  }
  console.log('');
  console.log('Usage:');
  console.log('  yarn test:backend                          Run all suites');
  console.log('  yarn test:backend --file=<pattern>         Run suites matching filename pattern');
  console.log('  yarn test:backend --filter=<regex>         Run tests matching name regex');
  console.log('  yarn test:backend --file=auth --filter=login  Combine file and name filters');
  console.log('');
  process.exit(0);
}

// ---- Log active filters ----
const activeGrepPattern = grepPattern !== undefined && grepPattern.length > 0 ? grepPattern : undefined;
const activeFilePattern = filePattern !== undefined && filePattern.length > 0 ? filePattern : undefined;

if (activeGrepPattern !== undefined || activeFilePattern !== undefined) {
  console.log('[run-electron-tests] Filters active:');
  if (activeFilePattern !== undefined) {
    console.log(`  --file="${activeFilePattern}"    (suite filename must contain this substring)`);
  }
  if (activeGrepPattern !== undefined) {
    console.log(`  --filter="${activeGrepPattern}"  (test/describe name must match this regex)`);
  }
  console.log('');
}

const electronBin = require('electron');
const testEntry = path.join(__dirname, '..', 'dist-test', 'tests', 'backend', 'test-main.js');
const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latentmail-test-'));

// Build a clean environment: inherit everything EXCEPT ELECTRON_RUN_AS_NODE
const cleanEnv = Object.assign({}, process.env);
delete cleanEnv['ELECTRON_RUN_AS_NODE'];
cleanEnv['LATENTMAIL_TEST_TEMP_DIR'] = testTempDir;

// Forward filter arguments as environment variables to the Electron child process
if (grepPattern !== undefined) {
  cleanEnv['MOCHA_GREP'] = grepPattern;
}
if (filePattern !== undefined) {
  cleanEnv['MOCHA_FILE_FILTER'] = filePattern;
}

function cleanupTempDir() {
  try {
    fs.rmSync(testTempDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  } catch (error) {
    console.error('[run-electron-tests] Failed to clean up test temp directory:', testTempDir, error.message);
  }
}

const child = spawn(String(electronBin), ['--no-warnings', testEntry], {
  env: cleanEnv,
  stdio: 'inherit',
});

child.on('close', (code) => {
  cleanupTempDir();
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  cleanupTempDir();
  console.error('[run-electron-tests] Failed to launch Electron:', error.message);
  process.exit(1);
});
