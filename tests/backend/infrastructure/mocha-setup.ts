/**
 * mocha-setup.ts — Programmatic Mocha runner configuration.
 *
 * Called from test-main.ts after all services have been initialized.
 * Discovers compiled test files from dist-test/tests/backend/suites/.
 */

import Mocha from 'mocha';
import * as path from 'path';
import * as fs from 'fs';

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
  const mocha = new Mocha({
    timeout: 30_000,
    reporter: 'spec',
  });

  // Navigate from dist-test/tests/backend/infrastructure/ up to dist-test/tests/backend/suites/
  const suitesDir = path.join(__dirname, '..', 'suites');

  if (fs.existsSync(suitesDir)) {
    const files = fs.readdirSync(suitesDir).filter((file) => file.endsWith('.test.js'));
    for (const file of files) {
      mocha.addFile(path.join(suitesDir, file));
    }
  } else {
    console.warn(`[mocha-setup] Suites directory not found: ${suitesDir}`);
  }

  return mocha;
}

/**
 * Run Mocha and return the failure count.
 * Wraps the callback-based mocha.run() in a Promise.
 *
 * @param mocha - Configured Mocha instance from createMochaRunner()
 * @returns Promise resolving with the number of test failures
 */
export function runMocha(mocha: Mocha): Promise<number> {
  return new Promise((resolve) => {
    mocha.run((failures) => resolve(failures));
  });
}
