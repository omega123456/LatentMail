'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runParallelTests = require('./parallel-test-orchestrator');

if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {}
}

const cliArgs = process.argv.slice(2);

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

function hasFlag(args, flags) {
  const flagList = Array.isArray(flags) ? flags : [flags];

  return args.some((argument) => {
    return flagList.some((flag) => argument === flag || argument.startsWith(flag + '='));
  });
}

function parseCoverageThresholdValue(flagName, rawValue, options = {}) {
  const allowMissingValue = options.allowMissingValue === true;

  if (rawValue === null) {
    if (allowMissingValue) {
      return 0;
    }

    console.error(`[test-runner] Missing value for ${flagName}. Use ${flagName}=N with a number between 0 and 100.`);
    process.exit(1);
  }

  const threshold = Number(rawValue);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    console.error(`[test-runner] Invalid ${flagName} value: "${rawValue}". Must be a number between 0 and 100.`);
    process.exit(1);
  }

  return threshold;
}

function spawnAsync(command, args) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, { stdio: 'inherit' });
    childProcess.on('error', reject);
    childProcess.on('close', (code) => resolve(code ?? 1));
  });
}

function cleanupCoverageTempDir(coverageTempDir) {
  if (coverageTempDir === null) return;

  try {
    fs.rmSync(coverageTempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    console.error('[run-parallel-tests] Failed to clean up coverage temp dir:', error.message);
  }
}

function getInterruptExitCode(interruptSignal) {
  if (interruptSignal === 'SIGINT') {
    return 130;
  }

  if (interruptSignal === 'SIGTERM') {
    return 143;
  }

  return 1;
}

function parseParallelOptions(args) {
  const coverageFlag = args.includes('--coverage');
  const checkCoverageValue = extractFlagValue(args, '--check-coverage');
  const checkCoverageFlag = checkCoverageValue !== null || args.includes('--check-coverage');
  const statementsThresholdValue = extractFlagValue(args, '--check-statements');
  const branchesThresholdValue = extractFlagValue(args, '--check-branches');
  const functionsThresholdValue = extractFlagValue(args, '--check-functions');
  const linesThresholdValue = extractFlagValue(args, '--check-lines');

  const metricCheckFlags = [
    { argumentName: '--check-statements', rawValue: statementsThresholdValue, metricName: 'statements' },
    { argumentName: '--check-branches', rawValue: branchesThresholdValue, metricName: 'branches' },
    { argumentName: '--check-functions', rawValue: functionsThresholdValue, metricName: 'functions' },
    { argumentName: '--check-lines', rawValue: linesThresholdValue, metricName: 'lines' },
  ];

  let sharedCoverageThreshold = null;
  if (checkCoverageFlag) {
    sharedCoverageThreshold = parseCoverageThresholdValue('--check-coverage', checkCoverageValue, {
      allowMissingValue: true,
    });
  }

  const coverageThresholds = {
    statements: sharedCoverageThreshold ?? 0,
    branches: 0,
    functions: sharedCoverageThreshold ?? 0,
    lines: sharedCoverageThreshold ?? 0,
  };

  let hasMetricCoverageCheck = false;
  for (const metricCheckFlag of metricCheckFlags) {
    if (metricCheckFlag.rawValue !== null) {
      coverageThresholds[metricCheckFlag.metricName] = parseCoverageThresholdValue(
        metricCheckFlag.argumentName,
        metricCheckFlag.rawValue
      );
      hasMetricCoverageCheck = true;
    }
  }

  const jobsValue = extractFlagValue(args, '--jobs');
  const jobsFlagPresent = jobsValue !== null || args.includes('--jobs');
  let concurrencyOverride = null;

  if (jobsFlagPresent) {
    const jobsRaw = jobsValue ?? '';
    const n = Number(jobsRaw);
    if (!Number.isInteger(n) || n < 1) {
      console.error('[run-parallel-tests] Error: --jobs must be a positive integer. Got: "' + jobsRaw + '"');
      process.exit(1);
    }

    concurrencyOverride = n;
  }

  const checkCoverageEnabled = checkCoverageFlag || hasMetricCoverageCheck;

  return {
    coverageEnabled: coverageFlag || checkCoverageEnabled,
    checkCoverageEnabled,
    coverageThresholds,
    concurrencyOverride,
  };
}

function discoverSuites(suitesSourceDir) {
  let suiteFiles;

  try {
    suiteFiles = fs
      .readdirSync(suitesSourceDir)
      .filter((file) => file.endsWith('.test.ts'))
      .sort();
  } catch {
    console.error('[run-parallel-tests] Could not read suites directory:', suitesSourceDir);
    process.exit(1);
  }

  if (suiteFiles.length === 0) {
    console.error('[run-parallel-tests] Error: No test suites found in', suitesSourceDir);
    process.exit(1);
  }

  return suiteFiles.map((file) => file.replace('.test.ts', '') + '.test');
}

function buildWorkerEnv(coverageTempDir) {
  const baseEnv = Object.assign({}, process.env);
  delete baseEnv['ELECTRON_RUN_AS_NODE'];
  delete baseEnv['MOCHA_GREP'];
  delete baseEnv['MOCHA_FILE_FILTER'];

  if (coverageTempDir !== null) {
    baseEnv['NODE_V8_COVERAGE'] = coverageTempDir;
  }

  return baseEnv;
}

async function runCoverageReporting(coverageTempDir, coverageThresholds, checkCoverageEnabled) {
  console.log('\n--- Coverage Report ---\n');

  let c8BinPath;
  try {
    c8BinPath = require.resolve('c8/bin/c8.js');
  } catch (error) {
    console.error('[test-runner] c8 not found — is it installed? Run: yarn add -D c8');
    console.error('[test-runner] Coverage report skipped.');
    return 0;
  }

  const commonArgs = [
    '--temp-directory=' + coverageTempDir,
    '--src=dist-test',
    '--all',
    '--include=dist-test/electron/**',
    '--exclude=dist-test/electron/main.js',
    '--exclude=dist-test/electron/preload.js',
    '--exclude=dist-test/electron/secrets.example.js',
    '--exclude=dist-test/electron/database/migrations/**',
    '--exclude=dist-test/electron/database/models.*',
    '--exclude=dist-test/electron/workers/**',
    '--exclude=dist-test/electron/cli/**',
    '--exclude=dist-test/electron/services/queue-types.*',
    '--exclude=dist-test/electron/services/search-options.*',
    '--exclude=dist-test/electron/services/native-drop-service.*',
    '--exclude=dist-test/electron/services/tray-service.*',
    '--exclude=dist-test/electron/utils/platform.*',
    '--exclude=dist-test/electron/utils/text-chunker.*',
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
    const c8ReportExitCode = await spawnAsync(process.execPath, [c8BinPath, 'report', ...reportArgs]);
    if (c8ReportExitCode !== 0) {
      console.warn('[test-runner] Warning: c8 report exited with code', c8ReportExitCode, '— continuing');
    }
  } catch (error) {
    console.warn('[test-runner] Warning: c8 report spawn failed:', error.message, '— continuing');
  }

  if (!checkCoverageEnabled) {
    return 0;
  }

  const checkArgs = [
    ...commonArgs,
    '--lines=' + coverageThresholds.lines,
    '--branches=' + coverageThresholds.branches,
    '--functions=' + coverageThresholds.functions,
    '--statements=' + coverageThresholds.statements,
  ];

  try {
    return await spawnAsync(process.execPath, [c8BinPath, 'check-coverage', ...checkArgs]);
  } catch (error) {
    console.warn('[test-runner] Warning: c8 check-coverage spawn failed:', error.message, '— continuing');
    return 0;
  }
}

async function main() {
  const listSuites = cliArgs.includes('--list');
  const {
    coverageEnabled,
    checkCoverageEnabled,
    coverageThresholds,
    concurrencyOverride,
  } = parseParallelOptions(cliArgs);

  const suitesSourceDir = path.join(__dirname, '..', 'tests', 'backend', 'suites');
  const suiteFilterValues = discoverSuites(suitesSourceDir);

  if (hasFlag(cliArgs, ['--filter', '--grep', '--file', '--suite'])) {
    console.error(
      '[run-parallel-tests] Error: --filter and --file are not supported in parallel mode. Use: yarn test:backend --file=<pattern> --filter=<pattern>'
    );
    return 1;
  }

  if (listSuites) {
    console.log('Available test suites (parallel mode):');
    console.log('');
    for (const suiteFilterValue of suiteFilterValues) {
      console.log('  ' + suiteFilterValue.replace('.test', ''));
    }
    console.log('');
    console.log('Usage:');
    console.log('  yarn test:backend:parallel                       Run all suites in parallel');
    console.log('  yarn test:backend:parallel --jobs=N              Limit concurrent workers to N');
    console.log('  yarn test:backend:parallel --coverage            Run with coverage report');
    console.log('  yarn test:backend:parallel --check-coverage=80   Run with coverage, fail if < 80%');
    console.log(
      '  yarn test:backend:parallel --check-statements=90 --check-branches=90 --check-functions=90 --check-lines=90'
    );
    console.log('');
    console.log("Note: Use 'yarn test:backend --file=<pattern> --filter=<regex>' for filtered runs.");
    return 0;
  }

  const defaultConcurrency = Math.min(os.cpus().length, 12, suiteFilterValues.length);
  const concurrency = concurrencyOverride ?? defaultConcurrency;

  if (coverageEnabled) {
    if (checkCoverageEnabled) {
      console.log('[run-parallel-tests] Coverage: enabled with thresholds');
      console.log('  statements=' + coverageThresholds.statements + '%');
      console.log('  branches=' + coverageThresholds.branches + '%');
      console.log('  functions=' + coverageThresholds.functions + '%');
      console.log('  lines=' + coverageThresholds.lines + '%');
    } else {
      console.log('[run-parallel-tests] Coverage: enabled');
    }
    console.log('');
  }

  let coverageTempDir = null;

  if (coverageEnabled) {
    coverageTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latentmail-cov-'));
    console.log('[run-parallel-tests] Coverage collection enabled (temp: ' + coverageTempDir + ')');
  }

  const baseEnv = buildWorkerEnv(coverageTempDir);

  const electronBin = String(require('electron'));
  const testEntry = path.join(__dirname, '..', 'dist-test', 'tests', 'backend', 'test-main.js');

  try {
    const result = await runParallelTests({
      suites: suiteFilterValues,
      concurrency,
      electronBin,
      testEntry,
      baseEnv,
    });

    if (result.interrupted) {
      return getInterruptExitCode(result.interruptSignal);
    }

    const anyFailed = result.results.some((suiteResult) => suiteResult.exitCode !== 0 || suiteResult.signal !== null);

    let c8CheckExitCode = 0;

    if (coverageEnabled) {
      c8CheckExitCode = await runCoverageReporting(coverageTempDir, coverageThresholds, checkCoverageEnabled);
    }

    if (anyFailed) {
      return 1;
    }

    if (checkCoverageEnabled && c8CheckExitCode !== 0) {
      return c8CheckExitCode;
    }

    return 0;
  } finally {
    cleanupCoverageTempDir(coverageTempDir);
  }
}

void main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    console.error('[run-parallel-tests] Failed to run parallel tests:', error.message);
    process.exit(1);
  });
