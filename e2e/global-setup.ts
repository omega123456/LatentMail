import { execFileSync } from 'node:child_process';

export default function globalSetup() {
  execFileSync('node', ['scripts/ensure-playwright-port.mjs'], { stdio: 'inherit' });
}
