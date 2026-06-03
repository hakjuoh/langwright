const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', '*.config.ts', '*.config.example.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'max-lines': ['error', { max: 1000, skipComments: true, skipBlankLines: true }],
      'max-lines-per-function': ['error', { max: 50, skipComments: true, skipBlankLines: true }],
      // "Single purpose only" cannot be checked semantically; these bound the
      // structural complexity that a multi-purpose function tends to accumulate.
      complexity: ['error', 10],
      'max-statements': ['error', 20],
      'max-depth': ['error', 3],
      'max-params': ['error', 4],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/require-await': 'error',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Awaited DSL calls (await steps`...`, await expect`...`) drive incremental
      // execution, so a floating DSL promise is a real ordering bug — keep it on.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['tests/unit/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'error',
    },
  },
  {
    files: ['scripts/**/*.js', 'eslint.config.cjs'],
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
