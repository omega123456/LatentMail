import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    env: { TZ: 'UTC' },
    include: ['src/tests/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['src/tests/setup.ts'],
    coverage: {
      provider: 'v8',
      thresholds: { lines: 90, functions: 90, statements: 90 },
    },
  },
});
