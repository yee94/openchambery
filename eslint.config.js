import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { globalIgnores } from 'eslint/config'

export default tseslint.config([
  globalIgnores(['dist', '.openchamber']),
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
])
