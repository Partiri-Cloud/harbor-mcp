// Flat ESLint config for the MCP server (TypeScript, ESM).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // The codebase uses leading-underscore names for intentionally unused
      // params / vars / caught errors (e.g. _client, _codeVerifier, _resource).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  // Must be last: turns off ESLint rules that conflict with Prettier formatting.
  prettierConfig,
);
