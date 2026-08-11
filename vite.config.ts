import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  clearScreen: false,
  server: { strictPort: true, port: 1420 },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'es2021', minify: !process.env.TAURI_ENV_DEBUG },
});
