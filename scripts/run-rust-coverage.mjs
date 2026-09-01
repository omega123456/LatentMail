import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const cargo = (args) =>
  spawnSync('rustup', ['run', 'stable', 'cargo', ...args], { stdio: 'inherit' });

/**
 * Delete every executable in the coverage target directory except the newest
 * `integration` test binary.
 *
 * The gate measures the integration tests, but cargo-llvm-cov finds object
 * files by scanning the target directory. Two kinds of leftover binary poison
 * the report, because each one merges a second, never-executed copy of the
 * library into it: an app binary, and an older `integration` binary from a
 * build with a different feature set. Such a copy adds thousands of zero-count
 * lines and functions, so the gate fails even when every test passes.
 * `--no-clean` keeps those binaries around forever, so remove them before each
 * run. Compiled dependencies stay in place, so the run stays fast.
 */
const pruneForeignCoverageBinaries = () => {
  const depsDir = path.join('src-tauri', 'target', 'llvm-cov-target', 'debug', 'deps');
  if (!existsSync(depsDir)) {
    return;
  }

  // Compiled artifacts all carry an extension; test and app binaries do not.
  const binaries = readdirSync(depsDir)
    .filter((name) => !name.includes('.'))
    .map((name) => path.join(depsDir, name))
    .filter((candidate) => statSync(candidate).isFile());
  const newestTestBinary = binaries
    .filter((candidate) => path.basename(candidate).startsWith('integration-'))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];

  for (const candidate of binaries) {
    if (candidate !== newestTestBinary) {
      rmSync(candidate, { force: true });
    }
  }
};

cargo(['llvm-cov', 'clean', '--profraw-only', '--manifest-path', 'src-tauri/Cargo.toml']);

pruneForeignCoverageBinaries();

const result = cargo([
  'llvm-cov',
  'nextest',
  '--no-clean',
  '--manifest-path',
  'src-tauri/Cargo.toml',
  '--features',
  'test-utils',
  '--no-default-features',
  '--fail-under-lines',
  '90',
  '--fail-under-functions',
  '90',
  '--fail-under-regions',
  '80',
]);

process.exit(result.status ?? 1);
