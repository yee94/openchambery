import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { globalIgnores } from 'eslint/config'

export default tseslint.config([
  globalIgnores(['dist', '.yuri']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // The codebase already marks deliberately-unused bindings with a leading
      // underscore (`_state`, `_reason`, required-but-ignored parameters).
      // Honour that convention instead of forcing those sites to delete a
      // parameter that a signature or callback contract still requires.
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      // Path normalization has exactly one home. Hand-rolling it at the call
      // site is how this repo ended up with ~100 slightly different
      // conventions, only a handful of which handled Windows drive-letter
      // case — consistent on macOS, divergent on Windows.
      //
      // Warning while the existing sites are migrated; promoted to error once
      // the last duplicate is gone.
      'no-restricted-syntax': ['warn', {
        selector: "CallExpression[callee.property.name='replace'][arguments.0.regex.pattern='\\\\\\\\']",
        message: 'Use normalizePath / normalizeDirectoryKey from @/lib/pathNormalization instead of converting path separators by hand.',
      }, {
        selector: "CallExpression[callee.property.name='replace'][arguments.0.regex.pattern='^([a-z]):']",
        message: 'Use normalizePath / normalizeDirectoryKey from @/lib/pathNormalization instead of case-folding Windows drive letters by hand.',
      }],
    },
  },
  {
    // The authoritative module is the one place allowed to do this.
    files: ['**/lib/pathNormalization.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['packages/ui/src/components/chat/ChatInput.tsx', 'packages/ui/src/components/chat/useComposerTextareaAutosize.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: 'react', importNames: ['useCallback'], message: 'Use @reactuses/core useEvent for event callbacks; useMemo or ordinary functions for render-time selectors and factories.' }],
      }],
      'no-restricted-properties': ['error', {
        property: 'useCallback',
        message: 'Use @reactuses/core useEvent for event callbacks; useMemo or ordinary functions for render-time selectors and factories.',
      }],
    },
  },
])
