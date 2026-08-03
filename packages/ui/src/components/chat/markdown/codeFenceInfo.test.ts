import { describe, expect, test } from 'bun:test';

import { languageFromFilePath, parseCodeFenceInfo } from './codeFenceInfo';

describe('parseCodeFenceInfo', () => {
  test('reads the language of a code reference from the referenced file', () => {
    const info = parseCodeFenceInfo('102:106:packages/ui/src/components/chat/lib/markdownHydrationWindow.ts');

    expect(info.lang).toBe('typescript');
    expect(info.reference).toBe(true);
  });

  test('keeps the path casing in the label, so filenames stay readable', () => {
    const info = parseCodeFenceInfo('102:106:packages/ui/src/lib/markdownHydrationWindow.ts');

    expect(info.label).toBe('packages/ui/src/lib/markdownHydrationWindow.ts:102-106');
  });

  test('collapses a single-line range to one number', () => {
    expect(parseCodeFenceInfo('12:12:src/app.ts').label).toBe('src/app.ts:12');
  });

  test('passes a plain language fence through, lowercased for the registry', () => {
    expect(parseCodeFenceInfo('TSX')).toEqual({ lang: 'tsx', label: 'tsx', reference: false });
  });

  test('falls back to plain text for an empty info string', () => {
    expect(parseCodeFenceInfo(undefined).lang).toBe('text');
    expect(parseCodeFenceInfo('   ').lang).toBe('text');
  });

  test('treats a colon-separated string without a line range as a language', () => {
    // Only `digits:digits:path` is a reference; anything else is an id we hand
    // to Shiki unchanged rather than guessing at a file path.
    expect(parseCodeFenceInfo('src/app.ts').reference).toBe(false);
    expect(parseCodeFenceInfo('12:src/app.ts').reference).toBe(false);
  });

  test('marks a .mmd reference as a reference so it is not rendered as a diagram', () => {
    const info = parseCodeFenceInfo('1:4:docs/flow.mmd');

    expect(info.lang).toBe('mermaid');
    expect(info.reference).toBe(true);
  });
});

describe('languageFromFilePath', () => {
  test('maps the extensions used across the app to bundled Shiki ids', () => {
    expect(languageFromFilePath('a/b.tsx')).toBe('tsx');
    expect(languageFromFilePath('a/b.mts')).toBe('typescript');
    expect(languageFromFilePath('a/b.py')).toBe('python');
    expect(languageFromFilePath('a/b.sh')).toBe('shellscript');
    expect(languageFromFilePath('a/b.yml')).toBe('yaml');
  });

  test('recognizes extensionless files by name', () => {
    expect(languageFromFilePath('build/Dockerfile')).toBe('docker');
    expect(languageFromFilePath('Makefile')).toBe('make');
  });

  test('treats a leading dot as part of the name, not an extension', () => {
    expect(languageFromFilePath('.env')).toBe('dotenv');
    expect(languageFromFilePath('.unknownrc')).toBe('text');
  });

  test('handles windows separators', () => {
    expect(languageFromFilePath('src\\components\\App.tsx')).toBe('tsx');
  });

  test('falls back to plain text for an unmapped extension', () => {
    expect(languageFromFilePath('a/b.unknownext')).toBe('text');
    expect(languageFromFilePath('')).toBe('text');
  });
});
