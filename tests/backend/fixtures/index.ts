/**
 * fixtures/index.ts — Typed fixture loader for backend tests.
 *
 * Resolves fixture paths relative to the repository root, regardless of
 * where the compiled output resides.
 *
 * At runtime the compiled file is at:
 *   dist-test/tests/backend/fixtures/index.js
 *
 * Going up 4 levels from __dirname reaches the repo root:
 *   dist-test/tests/backend/fixtures/ → dist-test/tests/backend/ → dist-test/tests/ → dist-test/ → (repo root)
 */

import * as fs from 'fs';
import * as path from 'path';

// Resolve repo root relative to the compiled output location
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/**
 * Load a fixture file and return its raw Buffer.
 *
 * @param relativePath - Path relative to tests/backend/fixtures/ (e.g. 'emails/welcome.eml')
 * @returns Raw file contents as a Buffer
 */
export function loadFixture(relativePath: string): Buffer {
  const absolutePath = path.join(REPO_ROOT, 'tests', 'backend', 'fixtures', relativePath);
  return fs.readFileSync(absolutePath);
}

/**
 * Load a fixture file and return its contents as a string.
 *
 * @param relativePath - Path relative to tests/backend/fixtures/
 * @param encoding - Text encoding (default 'utf8')
 * @returns File contents as a string
 */
export function loadFixtureAsString(relativePath: string, encoding: BufferEncoding = 'utf8'): string {
  return loadFixture(relativePath).toString(encoding);
}

/**
 * Get the absolute filesystem path to a fixture file without reading it.
 * Useful when a service needs a file path (e.g. attachment downloads).
 *
 * @param relativePath - Path relative to tests/backend/fixtures/
 * @returns Absolute filesystem path
 */
export function getFixturePath(relativePath: string): string {
  return path.join(REPO_ROOT, 'tests', 'backend', 'fixtures', relativePath);
}
