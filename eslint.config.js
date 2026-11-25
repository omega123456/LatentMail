import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const magicNumbersRule = tseslint.plugin.rules['no-magic-numbers'];

function listHolder(list) {
  const holder = list.parent;
  if (holder.type === 'TSAsExpression') return holder.parent;
  return holder;
}

function isNamedListMember(literal) {
  const element = literal.parent.type === 'UnaryExpression' ? literal.parent : literal;
  const list = element.parent;
  if (list.type !== 'ArrayExpression') return false;
  const holder = listHolder(list);
  const isConstDeclarator = holder.type === 'VariableDeclarator' && holder.parent.kind === 'const';
  return isConstDeclarator;
}

const namedListAwareMagicNumbers = {
  meta: magicNumbersRule.meta,
  defaultOptions: magicNumbersRule.defaultOptions,
  create(context) {
    const reportUnlessNamedListMember = (descriptor) => {
      if (isNamedListMember(descriptor.node)) return;
      context.report(descriptor);
    };
    const filteredContext = Object.create(context, {
      report: { value: reportUnlessNamedListMember },
    });
    return magicNumbersRule.create(filteredContext);
  },
};

const latentmailPlugin = { rules: { 'no-magic-numbers': namedListAwareMagicNumbers } };

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'src-tauri/target/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    settings: { 'jsx-a11y': { components: { TextInput: 'input', TextArea: 'textarea' } } },
    plugins: { latentmail: latentmailPlugin },
    rules: {
      'no-console': 'error',
      'id-length': ['error', { min: 2, properties: 'never' }],
      'object-shorthand': ['error', 'consistent'],
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-nested-ternary': 'error',
      'max-depth': ['error', 2],
      'max-lines': ['error', 400],
      'max-lines-per-function': ['error', 60],
      'max-params': ['error', 3],
      complexity: ['error', 10],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'IfStatement[alternate]',
          message: 'Avoid else — use early returns, a named helper, or a lookup table.',
        },
        {
          selector: 'SwitchStatement',
          message: 'Avoid switch — use a lookup table or early returns.',
        },
      ],
      'latentmail/no-magic-numbers': [
        'error',
        {
          ignore: [0, 1, -1],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreNumericLiteralTypes: true,
          ignoreEnums: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],
    },
  },
  {
    files: ['e2e/**/*.ts'],
    rules: {
      'max-depth': ['error', 2],
      'max-lines': ['error', 400],
      'max-lines-per-function': ['error', 60],
    },
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
