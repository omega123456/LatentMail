'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWindows = process.platform === 'win32';
const COVERAGE_FLAG_PREFIXES = [
  '--coverage',
  '--check-coverage',
  '--check-statements',
  '--check-branches',
  '--check-functions',
  '--check-lines',
];

function localBin(name) {
  return path.join(path.resolve(__dirname, '..'), 'node_modules', '.bin', isWindows ? name + '.cmd' : name);
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
    ['test', '--config', 'dist-test/tests/frontend/playwright.config.js', ...playwrightArgs],
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

  const reportArgs = [
    c8BinPath,
    'report',
    `--temp-directory=${coverageTempDir}`,
    '--reporter=text',
    '--reporter=html',
    '--reporter=lcov',
    '--reports-dir=coverage/frontend',
  ];
  const reportCode = await spawnAsync(process.execPath, reportArgs);

  let checkCode = 0;
  if (thresholdCheckEnabled) {
    const stmts = checkStatements ?? 0;
    const branches = checkBranches ?? 0;
    const funcs = checkFunctions ?? 0;
    const lines = checkLines ?? 0;
    const checkArgs = [
      c8BinPath,
      'check-coverage',
      `--temp-directory=${coverageTempDir}`,
      `--statements=${stmts}`,
      `--branches=${branches}`,
      `--functions=${funcs}`,
      `--lines=${lines}`,
    ];
    checkCode = await spawnAsync(process.execPath, checkArgs);
  }

  return { reportCode, checkCode };
}

async function main() {
  if (isWindows) {
    try {
      execSync('chcp 65001', { stdio: 'ignore' });
    } catch {
      // Ignore errors (for example if chcp is unavailable)
    }
  }
  const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latentmail-frontend-test-'));
  cleanEnv['LATENTMAIL_TEST_TEMP_DIR'] = testTempDir;
  fs.writeFileSync(
    path.join(testTempDir, '.frontend-test-owner.json'),
    JSON.stringify({ pid: process.pid, role: 'frontend-test-launcher', createdAt: Date.now() }),
    'utf8',
  );


  const args = process.argv.slice(2);
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

  const playwrightArgs = args.filter((a) => {
    return !COVERAGE_FLAG_PREFIXES.some((flag) => {
      if (flag === '--coverage') {
        return a === flag || a.startsWith(flag + '=');
      }

      return a.startsWith(flag);
    });
  });

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  childEnv.LATENTMAIL_TEST_MODE = '1';

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
    testExitCode = await runPlaywright(playwrightArgs, childEnv);
    finalExitCode = testExitCode;

    if (coverageEnabled && coverageTempDir) {
      const jsonFiles = fs.readdirSync(coverageTempDir).filter((f) => f.endsWith('.json'));
      if (jsonFiles.length === 0) {
        console.error(
          '[frontend-runner] Warning: No coverage data files found. Coverage collection may have failed.'
        );

        if (thresholdCheckEnabled) {
          if (finalExitCode === 0) finalExitCode = 1;
          return finalExitCode;
        }
      }

      const { reportCode, checkCode } = await runFrontendCoverageReporting(
        coverageTempDir,
        thresholdCheckEnabled,
        checkStatements,
        checkBranches,
        checkFunctions,
        checkLines
      );

      if (finalExitCode === 0 && reportCode !== 0) {
        finalExitCode = reportCode;
      }

      if (finalExitCode === 0 && checkCode !== 0) {
        finalExitCode = checkCode;
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

  return finalExitCode;
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
    console.error('[run-frontend-tests] Failed to clean up test temp directory:', testTempDir, error.message);
  }
}


main()
  .then((code) => {
    cleanupTempDir();
    process.exit(code ?? 1);
  })
  .catch((err) => {
    cleanupTempDir();
    console.error(err);
    process.exit(1);
  });
