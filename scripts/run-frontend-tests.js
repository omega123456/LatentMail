'use strict';

/**
 * run-frontend-tests.js
 *
 * Launcher for the Playwright/Electron frontend test suite.
 *
 * Supported flags:
 *   --filter=<regex>         Filter tests by name (Playwright --grep, regex-capable)
 *   --grep=<regex>           Alias for --filter
 *   --file=<pattern>         Filter test suite files by filename (substring, case-insensitive)
 *   --suite=<pattern>        Alias for --file
 *   --list                   List all available test suites and exit (no build required)
 *   --coverage               Generate coverage report after tests finish
 *   --check-coverage[=N]     Fail if coverage is below N (defaults to 0)
 *   --check-statements=N     Fail if statement coverage is below N
 *   --check-branches=N       Fail if branch coverage is below N
 *   --check-functions=N      Fail if function coverage is below N
 *   --check-lines=N          Fail if line coverage is below N
 *   --update-snapshots       Update Playwright visual snapshots (passed through)
 *
 * Usage examples:
 *   yarn test:frontend --filter=login
 *   yarn test:frontend --file=auth
 *   yarn test:frontend --file=compose --filter="subject line"
 *   yarn test:frontend --list
 *   yarn test:frontend --coverage
 *   yarn test:frontend --check-coverage=80
 *   yarn test:frontend --check-statements=90 --check-lines=90
 *   node scripts/run-frontend-tests.js --list
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWindows = process.platform === 'win32';
let testTempDir = null;

// Flag prefixes consumed by this launcher that must NOT be forwarded to Playwright as-is
const COVERAGE_FLAG_PREFIXES = [
  '--coverage',
  '--check-coverage',
  '--check-statements',
  '--check-branches',
  '--check-functions',
  '--check-lines',
];

// Filter/control flags consumed by this launcher and translated to Playwright equivalents (or handled locally)
const FILTER_FLAG_PREFIXES = ['--filter', '--grep', '--file', '--suite', '--list'];

// ---- Path / file-extension constants ----
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SUITES_SOURCE_DIR = path.join(PROJECT_ROOT, 'tests', 'frontend', 'suites');
const PLAYWRIGHT_CONFIG_PATH = 'dist-test/tests/frontend/playwright.config.js';
const SUITE_SOURCE_SUFFIX = '.test.ts';

// ---- Utility helpers ----

function localBin(name) {
  return path.join(PROJECT_ROOT, 'node_modules', '.bin', isWindows ? name + '.cmd' : name);
}

function hasFlag(args, flag) {
  return args.some((a) => a === flag || a.startsWith(flag + '='));
}

function extractFlagValue(args, flag) {
  const arg = args.find((a) => a === flag || a.startsWith(flag + '='));
  if (!arg) return null;
  const idx = arg.indexOf('=');
  return idx >= 0 ? arg.slice(idx + 1) : '';
}

/**
 * Returns the value of the first matching flag alias found in args, or null if none found.
 * Each entry in `flags` is tried in order; the first match wins.
 */
function extractFlagValueAlias(args, ...flags) {
  for (const flag of flags) {
    const value = extractFlagValue(args, flag);
    if (value !== null) return value;
  }
  return null;
}

function parseCoverageThresholdValue(flagName, rawValue, options = {}) {
  const allowMissingValue = options.allowMissingValue === true;

  if (rawValue === null) {
    if (allowMissingValue) return 0;
    console.error(
      `[frontend-runner] Missing value for ${flagName}. Use ${flagName}=N with a number between 0 and 100.`
    );
    process.exit(1);
  }

  const threshold = Number(rawValue);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    console.error(
      `[frontend-runner] Invalid ${flagName} value: "${rawValue}". Must be a number between 0 and 100.`
    );
    process.exit(1);
  }

  return threshold;
}

function spawnAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => reject(err));
  });
}

function runPlaywright(playwrightArgs, childEnv) {
  return spawnAsync(
    localBin('playwright'),
    ['test', '--config', PLAYWRIGHT_CONFIG_PATH, ...playwrightArgs],
    {
      shell: isWindows,
      env: childEnv,
    }
  );
}

async function rebuildAngularForCoverage() {
  console.log('[frontend-runner] Rebuilding Angular with electron-coverage config...');

  const code = await spawnAsync(localBin('ng'), ['build', '--configuration=electron-coverage'], {
    shell: isWindows,
  });

  if (code !== 0) {
    throw new Error(`Angular rebuild failed with exit code ${code}`);
  }

  console.log('[frontend-runner] Angular rebuild complete.');
}

async function runFrontendCoverageReporting(
  coverageTempDir,
  thresholdCheckEnabled,
  checkStatements,
  checkBranches,
  checkFunctions,
  checkLines
) {
  const c8BinPath = require.resolve('c8/bin/c8.js');

  // Coverage script URLs are bundle paths (dist-test/.../browser/*.js); c8 remaps them via source maps
  // to original sources (e.g. node_modules/@angular/..., src/...). Apply exclude after remap so
  // node_modules is excluded from the report.
  const excludePatterns = [
    '**/node_modules/**',
    '**/assets/**',
    'src/environments/**',
    'src/app/core/models/**',
    'src/app/core/guards/setup.guard.ts',
    'src/app/features/auth/auth-landing.component.ts',
    'src/app/shared/components/email-actions/email-action.model.ts',
    'src/typings.d.ts',
  ];
  const reportArgs = [
    c8BinPath,
    'report',
    `--temp-directory=${coverageTempDir}`,
    ...excludePatterns.map((p) => `--exclude=${p}`),
    '--exclude-after-remap',
    '--reporter=text',
    '--reporter=html',
    '--reporter=lcov',
    '--reports-dir=coverage/frontend',
  ];

  // Run threshold check in the same process as report so the same Report (with exclude-after-remap)
  // is used; the separate "check-coverage" command does not pass excludeAfterRemap to Report.
  if (thresholdCheckEnabled) {
    const stmts = checkStatements ?? 0;
    const funcs = checkFunctions ?? 0;
    const lines = checkLines ?? 0;
    reportArgs.push(
      '--check-coverage',
      `--statements=${stmts}`,
      `--branches=0`,
      `--functions=${funcs}`,
      `--lines=${lines}`,
    );
  }

  const exitCode = await spawnAsync(process.execPath, reportArgs);
  return exitCode;
}

// ---- Suite discovery helpers ----

/**
 * Returns sorted list of .test.ts filenames from the frontend suites source directory.
 * Reads TypeScript sources so this works before any build step.
 */
function discoverSuiteFiles() {
  try {
    return fs.readdirSync(SUITES_SOURCE_DIR).filter((f) => f.endsWith(SUITE_SOURCE_SUFFIX)).sort();
  } catch {
    return [];
  }
}

/**
 * Prints available test suites and usage information, then exits.
 * Does NOT require a prior build — reads TypeScript source filenames directly.
 */
function handleListSuites() {
  const suiteFiles = discoverSuiteFiles();
  if (suiteFiles.length === 0) {
    console.error('[frontend-runner] Could not find any test suites in tests/frontend/suites/');
    process.exit(1);
  }

  console.log('');
  console.log('Available frontend test suites:');
  console.log('');
  for (const file of suiteFiles) {
    console.log('  ' + file.replace(SUITE_SOURCE_SUFFIX, ''));
  }
  console.log('');
  console.log('Usage:');
  console.log('  yarn test:frontend                                    Run all frontend suites');
  console.log('  yarn test:frontend --file=<pattern>                  Run suites matching filename pattern');
  console.log('  yarn test:frontend --filter=<regex>                  Run tests matching name regex');
  console.log('  yarn test:frontend --file=compose --filter="draft"   Combine file and name filters');
  console.log('  yarn test:frontend --coverage                         Run with coverage report');
  console.log('  yarn test:frontend --check-coverage=80               Run with coverage, fail if < 80%');
  console.log('  yarn test:frontend --check-statements=90 --check-lines=90');
  console.log('  node scripts/run-frontend-tests.js --list            List suites (no build needed)');
  console.log('');
  process.exit(0);
}

/**
 * Given a case-insensitive substring pattern, validates that at least one suite matches,
 * logs the matches, and returns the pattern for Playwright to use as a file filter.
 *
 * Playwright treats positional CLI arguments as regex patterns matched against test file
 * paths. Passing the raw (lowercased) pattern is equivalent to a substring match against
 * the suite filename and avoids Windows path-separator issues that arise with absolute paths.
 *
 * Exits with an error if no source files match the pattern.
 */
function resolveFileFilterArgs(filePattern) {
  const suiteFiles = discoverSuiteFiles();
  const lowerPattern = filePattern.toLowerCase();
  const matched = suiteFiles.filter((f) => f.toLowerCase().includes(lowerPattern));

  if (matched.length === 0) {
    console.error(`[frontend-runner] No test suites matched file pattern: "${filePattern}"`);
    console.error('[frontend-runner] Run "node scripts/run-frontend-tests.js --list" to see available suites.');
    process.exit(1);
  }

  console.log(`[frontend-runner]   Matched ${matched.length} suite(s):`);
  for (const f of matched) {
    console.log('    ' + f.replace(SUITE_SOURCE_SUFFIX, ''));
  }

  // Playwright treats positional args as regex patterns matched against test file paths.
  // Return the raw lowercase pattern — it behaves as a substring match against suite
  // filenames and avoids Windows backslash issues with absolute path arguments.
  return [lowerPattern];
}

// ---- Main ----

async function main() {
  if (isWindows) {
    try {
      execSync('chcp 65001', { stdio: 'ignore' });
    } catch {
      // Ignore errors (for example if chcp is unavailable)
    }
  }

  const args = process.argv.slice(2);

  // ---- Handle --list: reads source files only, no build required ----
  if (hasFlag(args, '--list')) {
    handleListSuites(); // always exits
  }

  // ---- Parse filter flags ----
  const grepPattern = extractFlagValueAlias(args, '--filter', '--grep');
  const filePattern = extractFlagValueAlias(args, '--file', '--suite');

  // Normalize to undefined when the flag is absent or empty so logging is clean
  const activeGrepPattern = grepPattern !== null && grepPattern.length > 0 ? grepPattern : undefined;
  const activeFilePattern = filePattern !== null && filePattern.length > 0 ? filePattern : undefined;

  // ---- Log active filters (mirrors run-electron-tests.js style) ----
  if (activeGrepPattern !== undefined || activeFilePattern !== undefined) {
    console.log('[frontend-runner] Filters active:');
    if (activeFilePattern !== undefined) {
      console.log(`  --file="${activeFilePattern}"    (suite filename must contain this substring)`);
    }
    if (activeGrepPattern !== undefined) {
      console.log(`  --filter="${activeGrepPattern}"  (test/describe name must match this regex)`);
    }
    console.log('');
  }

  // ---- Build Playwright pass-through args ----
  // Strip coverage flags (handled above) and filter flags (translated below).
  // All other args (e.g. --update-snapshots, --headed, --reporter, etc.) are forwarded as-is.
  const playwrightPassthroughArgs = args.filter((a) => {
    // Exclude coverage flags
    const isCoverageFlag = COVERAGE_FLAG_PREFIXES.some((flag) => {
      if (flag === '--coverage') {
        return a === flag || a.startsWith(flag + '=');
      }
      return a.startsWith(flag);
    });
    if (isCoverageFlag) return false;

    // Exclude filter/control flags (we translate them into Playwright-native equivalents below)
    const isFilterFlag = FILTER_FLAG_PREFIXES.some((flag) => a === flag || a.startsWith(flag + '='));
    if (isFilterFlag) return false;

    return true;
  });

  // ---- Translate filter flags to Playwright-native equivalents ----
  // NOTE: resolveFileFilterArgs() may call process.exit(1) if the pattern matches nothing.
  // It is called here — before temp dir creation — so no orphan dirs are left on bad input.
  const filterPlaywrightArgs = [];
  if (activeGrepPattern !== undefined) {
    // Playwright accepts --grep <regex> (space-separated) or --grep=<regex>; use space form for safety
    filterPlaywrightArgs.push('--grep', activeGrepPattern);
  }
  if (activeFilePattern !== undefined) {
    // Playwright accepts positional file path arguments to restrict which suites run
    const fileArgs = resolveFileFilterArgs(activeFilePattern);
    filterPlaywrightArgs.push(...fileArgs);
  }

  const finalPlaywrightArgs = [...playwrightPassthroughArgs, ...filterPlaywrightArgs];

  // ---- Parse coverage flags ----
  const checkCoverageValue = extractFlagValue(args, '--check-coverage');
  const checkCoverageFlag = checkCoverageValue !== null || args.includes('--check-coverage');
  const checkStatementsValue = extractFlagValue(args, '--check-statements');
  const checkBranchesValue = extractFlagValue(args, '--check-branches');
  const checkFunctionsValue = extractFlagValue(args, '--check-functions');
  const checkLinesValue = extractFlagValue(args, '--check-lines');

  let baseThreshold = null;
  if (checkCoverageFlag) {
    baseThreshold = parseCoverageThresholdValue('--check-coverage', checkCoverageValue, {
      allowMissingValue: true,
    });
  }

  const checkStatements =
    checkStatementsValue !== null
      ? parseCoverageThresholdValue('--check-statements', checkStatementsValue)
      : baseThreshold;
  const checkBranches =
    checkBranchesValue !== null
      ? parseCoverageThresholdValue('--check-branches', checkBranchesValue)
      : baseThreshold !== null
        ? 0
        : null;
  const checkFunctions =
    checkFunctionsValue !== null
      ? parseCoverageThresholdValue('--check-functions', checkFunctionsValue)
      : baseThreshold;
  const checkLines =
    checkLinesValue !== null ? parseCoverageThresholdValue('--check-lines', checkLinesValue) : baseThreshold;

  const hasMetricCoverageCheck =
    checkStatementsValue !== null ||
    checkBranchesValue !== null ||
    checkFunctionsValue !== null ||
    checkLinesValue !== null;
  const thresholdCheckEnabled = checkCoverageFlag || hasMetricCoverageCheck;
  const coverageEnabled = hasFlag(args, '--coverage') || thresholdCheckEnabled;

  // ---- Set up temp directory ----
  testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latentmail-frontend-test-'));
  fs.writeFileSync(
    path.join(testTempDir, '.frontend-test-owner.json'),
    JSON.stringify({ pid: process.pid, role: 'frontend-test-launcher', createdAt: Date.now() }),
    'utf8',
  );

  // ---- Build child environment ----
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  childEnv.LATENTMAIL_TEST_MODE = '1';
  childEnv.LATENTMAIL_TEST_TEMP_DIR = testTempDir;

  let coverageTempDir = null;

  if (coverageEnabled) {
    console.log('[frontend-runner] Coverage collection enabled.');
    await rebuildAngularForCoverage();
    coverageTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latentmail-frontend-cov-'));
    childEnv.PLAYWRIGHT_COVERAGE_DIR = coverageTempDir;
    console.log(`[frontend-runner] Coverage temp dir: ${coverageTempDir}`);
  } else {
    delete childEnv.PLAYWRIGHT_COVERAGE_DIR;
  }

  let testExitCode = 1;
  let finalExitCode = 1;

  try {
    testExitCode = await runPlaywright(finalPlaywrightArgs, childEnv);
    finalExitCode = testExitCode;

    if (coverageEnabled && coverageTempDir) {
      const jsonFiles = fs.readdirSync(coverageTempDir).filter((f) => f.endsWith('.json'));
      if (jsonFiles.length === 0) {
        console.error(
          '[frontend-runner] Warning: No coverage data files found. Coverage collection may have failed.'
        );

        if (thresholdCheckEnabled) {
          if (finalExitCode === 0) finalExitCode = 1;
          return { code: finalExitCode, testTempDir };
        }
      }

      const coverageExitCode = await runFrontendCoverageReporting(
        coverageTempDir,
        thresholdCheckEnabled,
        checkStatements,
        checkBranches,
        checkFunctions,
        checkLines
      );

      if (finalExitCode === 0 && coverageExitCode !== 0) {
        finalExitCode = coverageExitCode;
      }
    }
  } finally {
    if (coverageTempDir) {
      try {
        fs.rmSync(coverageTempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  return { code: finalExitCode, testTempDir: testTempDir };
}

function cleanupTempDir(dirPath) {
  if (!dirPath) return;
  try {
    fs.rmSync(dirPath, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  } catch (error) {
    console.error('[run-frontend-tests] Failed to clean up test temp directory:', dirPath, error.message);
  }
}

main()
  .then((result) => {
    cleanupTempDir(result.testTempDir);
    process.exit(result.code ?? 1);
  })
  .catch((err) => {
    cleanupTempDir(testTempDir);
    console.error(err);
    process.exit(1);
  });
