import { spawnSync } from 'node:child_process';

const cargo = (args) =>
  spawnSync('rustup', ['run', 'stable', 'cargo', ...args], { stdio: 'inherit' });

cargo(['llvm-cov', 'clean', '--profraw-only', '--manifest-path', 'src-tauri/Cargo.toml']);

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
