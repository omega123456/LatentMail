import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'rustup',
  [
    'run',
    'stable',
    'cargo',
    'llvm-cov',
    'nextest',
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
  ],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
