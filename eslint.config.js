import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/', 'graphify-out/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Browser-safety guard for the shipped library code
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error',
        { name: 'Buffer', message: 'Not available in browsers. Use TextEncoder/Uint8Array.' },
        { name: 'process', message: 'Not available in browsers.' },
        { name: 'require', message: 'ESM only.' },
      ],
      'no-restricted-imports': ['error', { patterns: ['node:*'] }],
    },
  },
);
