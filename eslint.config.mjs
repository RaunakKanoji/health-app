import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/.turbo/**', '**/dist/**', '**/.venv/**', '**/playwright-report/**', '**/test-results/**', '.local/**', 'apps/web/next-env.d.ts', 'apps/web/src/features/governance/**', 'packages/contracts/src/governance/**', 'packages/security/src/governance/**', 'tests/governance/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['**/*.{ts,tsx,js,mjs}'], languageOptions: { globals: { process:'readonly', console:'readonly', Buffer:'readonly', fetch:'readonly', URL:'readonly', AbortController:'readonly', setTimeout:'readonly', clearTimeout:'readonly', setInterval:'readonly', clearInterval:'readonly' } }, rules: { '@typescript-eslint/no-explicit-any': 'warn', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
);
