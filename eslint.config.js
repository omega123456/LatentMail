import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'src-tauri/target/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    settings: { 'jsx-a11y': { components: { TextInput: 'input' } } },
    rules: { 'no-console': 'error' },
  },
  {
    files: ['src/lib/app-log.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['scripts/**/*.mjs', 'playwright.config.mjs'],
    languageOptions: { globals: globals.node },
  },
);
