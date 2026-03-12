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
//   --filter=<regex>         Filter tests by name (Mocha grep, regex-capable, case-insensitive)
//   --grep=<regex>           Alias for --filter
//   --file=<pattern>         Filter test suite files by filename (substring, case-insensitive)
//   --suite=<pattern>        Alias for --file
//   --coverage               Generate coverage report after tests finish
//   --check-coverage[=N]     Fail if coverage is below N (defaults to 0)
//   --list                   List all available test suites and exit
//
// Usage examples:
//   yarn test:backend --filter=login
//   yarn test:backend --file=auth
//   yarn test:backend --file=queue --filter="retry"
//   yarn test:backend --coverage
//   yarn test:backend --check-coverage=80
//   yarn test:backend --list

const cliArgs = process.argv.slice(2);

const listSuites = cliArgs.includes('--list');

function extractFlagValue(args, flags) {
  const flagList = Array.isArray(flags) ? flags : [flags];

  for (const flag of flagList) {
    const prefix = flag + '=';
    const match = args.find((argument) => argument.startsWith(prefix));
    if (match !== undefined) {
      return match.slice(prefix.length);
    }
  }

  return null;
}

const coverageFlag = cliArgs.includes('--coverage');
const checkCoverageValue = extractFlagValue(cliArgs, '--check-coverage');
const checkCoverageFlag = checkCoverageValue !== null || cliArgs.includes('--check-coverage');
let coverageThreshold = 0;
if (checkCoverageFlag && checkCoverageValue !== null) {
  coverageThreshold = Number(checkCoverageValue);
  if (!Number.isFinite(coverageThreshold) || coverageThreshold < 0 || coverageThreshold > 100) {
    console.error(`[test-runner] Invalid --check-coverage value: "${checkCoverageValue}". Must be a number between 0 and 100.`);
    process.exit(1);
  }
}

const coverageEnabled = coverageFlag || checkCoverageFlag;

const grepPattern = extractFlagValue(cliArgs, ['--filter', '--grep']);
const filePattern = extractFlagValue(cliArgs, ['--file', '--suite']);

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
  console.log('  yarn test:backend --coverage                Run tests with coverage report');
  console.log('  yarn test:backend --check-coverage=80       Run tests, fail if coverage < 80%');
  console.log('');
  process.exit(0);
}

// ---- Log active filters ----
const activeGrepPattern = grepPattern !== null && grepPattern.length > 0 ? grepPattern : undefined;
const activeFilePattern = filePattern !== null && filePattern.length > 0 ? filePattern : undefined;

if (activeGrepPattern !== undefined || activeFilePattern !== undefined) {
  console.log('[run-electron-tests] Filters active:');
  if (activeFilePattern !== undefined) {
    console.log(`  --file="${activeFilePattern}"    (suite filename must contain this substring)`);
  }
  if (activeGrepPattern !== undefined) {
    console.log(`  --filter="${activeGrepPattern}"  (test/describe name must match this regex)`);
  }
}

if (coverageEnabled) {
  if (checkCoverageFlag) {
    console.log(`[test-runner] Coverage: enabled with threshold ${coverageThreshold}%`);
  } else {
    console.log('[test-runner] Coverage: enabled');
  }
}

if (activeGrepPattern !== undefined || activeFilePattern !== undefined || coverageEnabled) {
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
if (grepPattern !== null) {
  cleanEnv['MOCHA_GREP'] = grepPattern;
}
if (filePattern !== null) {
  cleanEnv['MOCHA_FILE_FILTER'] = filePattern;
}

const coverageTempDir = coverageEnabled ? fs.mkdtempSync(path.join(os.tmpdir(), 'latentmail-cov-')) : null;

if (coverageEnabled && coverageTempDir !== null) {
  cleanEnv['NODE_V8_COVERAGE'] = coverageTempDir;
  console.log(`[test-runner] Coverage collection enabled (temp: ${coverageTempDir})`);
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

function cleanupCoverageTempDir() {
  if (coverageTempDir === null) {
    return;
  }

  try {
    fs.rmSync(coverageTempDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  } catch (error) {
    console.error('[run-electron-tests] Failed to clean up coverage temp directory:', coverageTempDir, error.message);
  }
}

function spawnAsync(command, args) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, { stdio: 'inherit' });
    childProcess.on('error', reject);
    childProcess.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

async function runCoverageAndExit(electronExitCode) {
  function cleanup() {
    cleanupCoverageTempDir();
    cleanupTempDir();
  }

  if (!coverageEnabled) {
    cleanup();
    process.exit(electronExitCode);
    return;
  }

  console.log('\n--- Coverage Report ---\n');

  let c8ReportExitCode = 0;
  let c8CheckExitCode = 0;
  let c8SpawnError = null;

  try {
    let c8BinPath;
    try {
      c8BinPath = require.resolve('c8/bin/c8.js');
    } catch (error) {
      console.error('[test-runner] c8 not found — is it installed? Run: yarn add -D c8');
      console.error('[test-runner] Coverage report skipped.');
      c8SpawnError = error;
      return;
    }

    const commonArgs = [
      '--temp-directory=' + coverageTempDir,
      '--src=dist-test',
      '--all',
      '--include=dist-test/electron/**',
      '--exclude=dist-test/electron/main.js',
      '--exclude=dist-test/electron/preload.js',
      '--exclude=dist-test/electron/secrets.example.js',
      '--exclude=dist-test/electron/workers/**',
      '--exclude=dist-test/electron/cli/**',
      '--exclude=dist-test/tests/**',
      '--exclude=node_modules/**',
    ];

    const reportArgs = [
      ...commonArgs,
      '--reporter=text',
      '--reporter=html',
      '--reporter=lcov',
      '--reports-dir=coverage/backend',
    ];

    try {
      c8ReportExitCode = await spawnAsync(process.execPath, [c8BinPath, 'report', ...reportArgs]);
    } catch (error) {
      console.warn('[test-runner] Warning: c8 report spawn failed:', error.message, '— continuing');
    }

    if (c8ReportExitCode !== 0) {
      console.warn('[test-runner] Warning: c8 report exited with code', c8ReportExitCode, '— continuing');
    }

    if (checkCoverageFlag) {
      const checkArgs = [
        ...commonArgs,
        '--lines=' + coverageThreshold,
        '--branches=' + coverageThreshold,
        '--functions=' + coverageThreshold,
        '--statements=' + coverageThreshold,
      ];

      try {
        c8CheckExitCode = await spawnAsync(process.execPath, [c8BinPath, 'check-coverage', ...checkArgs]);
      } catch (error) {
        console.warn('[test-runner] Warning: c8 check-coverage spawn failed:', error.message, '— continuing');
      }
    }
  } finally {
    cleanup();
  }

  if (electronExitCode !== 0) {
    process.exit(electronExitCode);
  } else if (c8SpawnError !== null) {
    // c8 not found — treat as non-fatal warning, preserve test exit code
    process.exit(0);
  } else if (c8CheckExitCode !== 0) {
    process.exit(c8CheckExitCode);
  } else {
    process.exit(0);
  }
}

const child = spawn(String(electronBin), ['--no-warnings', testEntry], {
  env: cleanEnv,
  stdio: 'inherit',
});

child.on('close', (code) => {
  void runCoverageAndExit(code ?? 1);
});

child.on('error', (error) => {
  cleanupCoverageTempDir();
  cleanupTempDir();
  console.error('[run-electron-tests] Failed to launch Electron:', error.message);
  process.exit(1);
});
