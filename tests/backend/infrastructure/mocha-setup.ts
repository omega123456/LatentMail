/**
 * mocha-setup.ts — Programmatic Mocha runner configuration.
 *
 * Called from test-main.ts after all services have been initialized.
 * Discovers compiled test files from dist-test/tests/backend/suites/.
 *
 * Supports optional filtering via environment variables (set by run-electron-tests.js):
 *
 *   MOCHA_GREP        — Regex string passed to Mocha's `grep` option; filters tests by
 *                       their full name (describe + it title chain), case-insensitive.
 *                       Equivalent to PHPUnit's --filter for method names.
 *
 *   MOCHA_FILE_FILTER — Substring matched against each suite filename (case-insensitive).
 *                       Only suite files whose name contains this substring are loaded.
 *                       Equivalent to running a single test file in PHPUnit.
 *
 * Set via the run-electron-tests.js CLI:
 *   yarn test:backend --filter=<regex>       → MOCHA_GREP
 *   yarn test:backend --file=<substring>     → MOCHA_FILE_FILTER
 *   yarn test:backend --list                 → list available suites and exit
 */

import Mocha from 'mocha';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Parse a user-supplied grep pattern into a RegExp.
 *
 * Supports two forms:
 *   - Bare regex source:    "login"          → /login/i  (case-insensitive by default)
 *   - Slash-delimited form: "/login/i"       → /login/i  (flags taken from the literal)
 *
 * If the pattern is not a valid regex, returns a literal-string match instead of
 * throwing so that the runner always starts and reports a useful diagnostic.
 */
function parseGrepPattern(pattern: string): RegExp {
  const slashLiteralMatch = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
  if (slashLiteralMatch !== null) {
    try {
      return new RegExp(slashLiteralMatch[1], slashLiteralMatch[2]);
    } catch {
      console.warn(`[mocha-setup] Invalid regex in --filter: "${pattern}", falling back to literal match`);
      return new RegExp(pattern.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&'));
    }
  }

  try {
    return new RegExp(pattern, 'i');
  } catch {
    console.warn(`[mocha-setup] Invalid regex in --filter: "${pattern}", falling back to literal match`);
    return new RegExp(pattern.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&'), 'i');
  }
}

/**
 * Create a configured Mocha instance and add all discovered test files.
 *
 * Test files are discovered from the compiled output directory:
 *   dist-test/tests/backend/suites/**\/*.test.js
 *
 * The __dirname at runtime points to:
 *   dist-test/tests/backend/infrastructure/
 * so we navigate up one level to reach the suites directory.
 */
export function createMochaRunner(): Mocha {
  const grepPattern = process.env['MOCHA_GREP'];
  const fileFilter = process.env['MOCHA_FILE_FILTER'];

  // In parallel mode the orchestrator sets MOCHA_REPORTER=json-stream so it
  // can parse individual test events without displaying anything to the
  // terminal. Serial runs (yarn test:backend) leave the variable unset and
  // fall back to the human-readable 'spec' reporter.
  // Only whitelisted reporter names are accepted to prevent accidental
  // module loading from an inherited environment variable.
  const ALLOWED_REPORTERS = new Set(['spec', 'min', 'dot', 'json', 'json-stream']);
  const reporterEnv = process.env['MOCHA_REPORTER'];
  const reporter =
    reporterEnv !== undefined && ALLOWED_REPORTERS.has(reporterEnv) ? reporterEnv : 'spec';

  const mochaOptions: Mocha.MochaOptions = {
    timeout: 30_000,
    reporter,
    // Fail the run if zero tests execute — catches typos in --filter / --file
    // and guards against accidentally deleting all suite files.
    failZero: true,
  };

  // Apply test-name grep if provided (Mocha accepts a regex string or RegExp)
  if (grepPattern !== undefined && grepPattern.length > 0) {
    mochaOptions.grep = parseGrepPattern(grepPattern);
    console.log(`[mocha-setup] Grep filter active: ${String(mochaOptions.grep)}`);
  }

  const mocha = new Mocha(mochaOptions);

  // Navigate from dist-test/tests/backend/infrastructure/ up to dist-test/tests/backend/suites/
  const suitesDir = path.join(__dirname, '..', 'suites');

  if (!fs.existsSync(suitesDir)) {
    console.warn(`[mocha-setup] Suites directory not found: ${suitesDir}`);
    return mocha;
  }

  let files = fs.readdirSync(suitesDir).filter((file) => file.endsWith('.test.js'));

  // Apply file-name filter if provided (substring match, case-insensitive)
  if (fileFilter !== undefined && fileFilter.length > 0) {
    const lowerFilter = fileFilter.toLowerCase();
    const allFiles = files;
    files = files.filter((file) => file.toLowerCase().includes(lowerFilter));

    if (files.length === 0) {
      console.warn(
        `[mocha-setup] No suite files matched --file="${fileFilter}". ` +
          `Available suites: ${allFiles.map((file) => file.replace('.test.js', '')).join(', ')}`,
      );
    } else {
      console.log(
        `[mocha-setup] File filter "${fileFilter}" matched: ${files.map((file) => file.replace('.test.js', '')).join(', ')}`,
      );
    }
  }

  for (const file of files) {
    mocha.addFile(path.join(suitesDir, file));
  }

  return mocha;
}

export interface MochaRunStats {
  suites: number;
  tests: number;
  passes: number;
  pending: number;
  failures: number;
  duration: number;
}

export interface MochaRunResult {
  failures: number;
  stats: MochaRunStats;
}

/**
 * Run Mocha and return the failure count.
 * Wraps the callback-based mocha.run() in a Promise.
 *
 * @param mocha - Configured Mocha instance from createMochaRunner()
 * @returns Promise resolving with the number of test failures
 */
export function runMocha(mocha: Mocha): Promise<MochaRunResult> {
  return new Promise((resolve) => {
    const runner = mocha.run((failures) => {
      const pendingCount = runner.stats?.pending ?? 0;
      const stats: MochaRunStats = {
        suites: runner.stats?.suites ?? 0,
        tests: runner.stats?.tests ?? 0,
        passes: runner.stats?.passes ?? 0,
        pending: pendingCount,
        failures: runner.stats?.failures ?? failures,
        duration: runner.stats?.duration ?? 0,
      };

      if (pendingCount > 0) {
        console.error(`[mocha-setup] Pending tests are not allowed: ${pendingCount}`);
        resolve({
          failures: failures + pendingCount,
          stats,
        });
        return;
      }

      resolve({
        failures,
        stats,
      });
    });
  });
}
