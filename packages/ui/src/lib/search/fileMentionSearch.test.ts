import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import {
  isTestFileMentionPath,
  parseFileMentionQuery,
  rankFileMentionSearch,
  resolveFileMentionSearchQuery,
  type FileMentionSearchHit,
} from './fileMentionSearch';

const loadOpenChamberCatalog = (): FileMentionSearchHit[] => {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    let prefix = '';
    for (const part of parts.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${part}` : part;
      directories.add(`${prefix}/`);
    }
  }
  const toHit = (relativePath: string, isDirectory: boolean): FileMentionSearchHit => {
    const name = relativePath.split('/').filter(Boolean).pop() || relativePath;
    return {
      relativePath,
      name,
      extension: !isDirectory && name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined,
      isDirectory,
    };
  };
  return [
    ...[...directories].map((dir) => toHit(dir, true)),
    ...files.map((file) => toHit(file, false)),
  ];
};

const catalog = loadOpenChamberCatalog();

const rank = (query: string, limit = 12): string[] => (
  rankFileMentionSearch(catalog, query, { limit }).map((hit) => hit.relativePath)
);

const rankedHits = (query: string, limit = 12) => rankFileMentionSearch(catalog, query, { limit });

describe('file mention search — OpenChamber catalog', () => {
  test('indexes the current repository tree', () => {
    expect(catalog.length).toBeGreaterThan(1000);
    expect(catalog.some((hit) => hit.relativePath === 'packages/ui/src/components/chat/ChatInput.tsx')).toBe(true);
    expect(catalog.some((hit) => hit.relativePath === 'packages/ui/src/composer/' && hit.isDirectory)).toBe(true);
  });

  test('ChatInput.tsx ranks the source file first and keeps tests behind it', () => {
    const ranked = rank('ChatInput.tsx');
    expect(ranked[0]).toBe('packages/ui/src/components/chat/ChatInput.tsx');
    expect(ranked).not.toContain('.env');
    expect(ranked).not.toContain('packages/ui/src/App.tsx');
    const source = ranked.indexOf('packages/ui/src/components/chat/ChatInput.tsx');
    const surfaceTest = ranked.indexOf('packages/ui/src/components/chat/chatInputSurface.test.ts');
    if (surfaceTest >= 0) expect(source).toBeLessThan(surfaceTest);
  });

  test('ChatInput without suffix still prefers the source component over tests and junk', () => {
    const ranked = rank('ChatInput');
    expect(ranked[0]).toBe('packages/ui/src/components/chat/ChatInput.tsx');
    expect(ranked.indexOf('packages/ui/src/components/chat/ChatInput.tsx'))
      .toBeLessThan(ranked.indexOf('packages/ui/src/components/chat/chatInputSurface.ts'));
    expect(ranked).not.toContain('.env');
    expect(ranked).not.toContain('.npmrc');
  });

  test('fuzzySearch.ts prefers the lib source file over its test and unrelated configs', () => {
    const ranked = rank('fuzzySearch.ts');
    expect(ranked[0]).toBe('packages/ui/src/lib/search/fuzzySearch.ts');
    expect(ranked[1]).toBe('packages/ui/src/lib/search/fuzzySearch.test.ts');
    expect(ranked).not.toContain('vitest.config.ts');
    expect(ranked).not.toContain('vite.config.ts');
  });

  test('search.ts prefers the exact basename source file', () => {
    const ranked = rank('search.ts');
    expect(ranked[0]).toBe('packages/ui/src/lib/settings/search.ts');
    expect(ranked.indexOf('packages/ui/src/lib/settings/search.ts'))
      .toBeLessThan(ranked.indexOf('packages/ui/src/lib/search/fuzzySearch.ts'));
  });

  test('composer/ raises the composer directory above composer-named files', () => {
    const hits = rankedHits('composer/');
    expect(hits[0]?.relativePath).toBe('packages/ui/src/composer/');
    expect(hits[0]?.isDirectory).toBe(true);
    expect(hits.filter((hit) => hit.isDirectory).length).toBeGreaterThan(0);
    const dirIndex = hits.findIndex((hit) => hit.relativePath === 'packages/ui/src/composer/');
    const fileIndex = hits.findIndex((hit) => hit.relativePath === 'packages/ui/src/components/chat/composerFocus.ts');
    if (fileIndex >= 0) expect(dirIndex).toBeLessThan(fileIndex);
  });

  test('chat/ ranks chat directories before files', () => {
    const hits = rankedHits('chat/');
    expect(hits[0]?.isDirectory).toBe(true);
    expect(hits.map((hit) => hit.relativePath)).toEqual(expect.arrayContaining([
      'packages/ui/src/components/chat/',
      'packages/ui/src/mobile/chat/',
    ]));
    expect(hits.slice(0, 3).every((hit) => hit.isDirectory)).toBe(true);
  });

  test('input-store ranks the sync module ahead of its test and does not leak dotfiles', () => {
    const ranked = rank('input-store');
    expect(ranked[0]).toBe('packages/ui/src/sync/input-store.ts');
    expect(ranked[1]).toBe('packages/ui/src/sync/input-store.test.ts');
    expect(ranked).not.toContain('.env');
    expect(ranked).not.toContain('.nvmrc');
  });

  test('vitest.config.ts prefers the repo-root config over nested package copies', () => {
    const ranked = rank('vitest.config.ts');
    expect(ranked[0]).toBe('vitest.config.ts');
    expect(ranked).toContain('packages/ui/vitest.config.ts');
    expect(ranked.indexOf('vitest.config.ts')).toBeLessThan(ranked.indexOf('packages/ui/vitest.config.ts'));
  });

  test('fileMentionAutocompleteState.ts ranks the source module ahead of its test', () => {
    const ranked = rank('fileMentionAutocompleteState.ts');
    expect(ranked[0]).toBe('packages/ui/src/components/chat/fileMentionAutocompleteState.ts');
    expect(ranked[1]).toBe('packages/ui/src/components/chat/__tests__/fileMentionAutocompleteState.test.ts');
    expect(ranked).not.toContain('vite.config.ts');
  });

  test('searching for a test filename keeps that test file first', () => {
    const ranked = rank('fileMentionAutocompleteState.test.ts');
    expect(ranked[0]).toBe('packages/ui/src/components/chat/__tests__/fileMentionAutocompleteState.test.ts');
  });

  test('use-composer-controller ranks source ahead of the colocated test', () => {
    const ranked = rank('use-composer-controller');
    expect(ranked[0]).toBe('packages/ui/src/composer/use-composer-controller.ts');
    expect(ranked[1]).toBe('packages/ui/src/composer/use-composer-controller.test.ts');
    expect(ranked).not.toContain('.env');
  });

  test('packages/ui/ raises that package directory first', () => {
    const hits = rankedHits('packages/ui/');
    expect(hits[0]?.relativePath).toBe('packages/ui/');
    expect(hits[0]?.isDirectory).toBe(true);
  });

  test('sync/ prefers the UI sync directory over nested test folders', () => {
    const ranked = rank('sync/');
    expect(ranked[0]).toBe('packages/ui/src/sync/');
    expect(ranked.indexOf('packages/ui/src/sync/'))
      .toBeLessThan(ranked.indexOf('packages/ui/src/sync/__tests__/'));
  });

  test('FileMentionAutocomplete.tsx ranks the component source first', () => {
    expect(rank('FileMentionAutocomplete.tsx')[0]).toBe(
      'packages/ui/src/components/chat/FileMentionAutocomplete.tsx',
    );
  });

  test('DOCUMENTATION.md results are documentation files, not unrelated markdown', () => {
    const ranked = rank('DOCUMENTATION.md', 8);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((path) => path.endsWith('DOCUMENTATION.md'))).toBe(true);
  });

  test('document.ts prefers composer source over its test', () => {
    expect(rank('document.ts')[0]).toBe('packages/ui/src/composer/document.ts');
    const twins = rankFileMentionSearch([
      { relativePath: 'packages/ui/src/composer/document.ts', name: 'document.ts', extension: 'ts' },
      { relativePath: 'packages/ui/src/composer/document.test.ts', name: 'document.test.ts', extension: 'ts' },
    ], 'document.ts');
    expect(twins.map((hit) => hit.relativePath)).toEqual([
      'packages/ui/src/composer/document.ts',
      'packages/ui/src/composer/document.test.ts',
    ]);
  });

  test('document.test.ts prefers the test file when the query is the test name', () => {
    expect(rank('document.test.ts')[0]).toBe('packages/ui/src/composer/document.test.ts');
  });

  test('delivery.ts prefers composer source over the test twin', () => {
    const ranked = rank('delivery.ts');
    expect(ranked[0]).toBe('packages/ui/src/composer/delivery.ts');
    expect(ranked.indexOf('packages/ui/src/composer/delivery.ts'))
      .toBeLessThan(ranked.indexOf('packages/ui/src/composer/delivery.test.ts'));
  });

  test('a full relative path query returns that file first', () => {
    expect(rank('packages/ui/src/composer/document.ts')[0]).toBe(
      'packages/ui/src/composer/document.ts',
    );
  });

  test('search/ raises the search algorithm directory', () => {
    const ranked = rank('search/');
    expect(ranked).toContain('packages/ui/src/lib/search/');
    expect(ranked.indexOf('packages/ui/src/lib/search/')).toBe(0);
  });

  test('fileMention ranks mention source files ahead of tests and junk', () => {
    const ranked = rank('fileMention');
    expect(ranked[0]).toBe('packages/ui/src/lib/search/fileMentionSearch.ts');
    expect(ranked).toContain('packages/ui/src/components/chat/fileMentionAutocompleteState.ts');
    expect(ranked.indexOf('packages/ui/src/components/chat/FileMentionAutocomplete.tsx'))
      .toBeLessThan(ranked.indexOf('packages/ui/src/components/chat/FileMentionAutocomplete.test.ts'));
    expect(ranked).not.toContain('.env');
    expect(ranked).not.toContain('docs/');
  });

  test('does not insert unmatched short junk for an ordinary identifier query', () => {
    for (const query of ['ChatInput', 'fileMention', 'input-store', 'use-composer-controller']) {
      const ranked = rank(query);
      expect(ranked, query).not.toContain('.env');
      expect(ranked, query).not.toContain('.npmrc');
      expect(ranked, query).not.toContain('.nvmrc');
    }
  });
});

describe('file mention search — synthetic mix', () => {
  const hit = (relativePath: string, isDirectory = false): FileMentionSearchHit => {
    const name = relativePath.split('/').filter(Boolean).pop() || relativePath;
    return {
      relativePath,
      name,
      extension: !isDirectory && name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined,
      isDirectory,
    };
  };

  const project = [
    hit('src/yi.ts'),
    hit('src/yi/index.ts'),
    hit('src/yi.test.ts'),
    hit('packages/core/src/yi.ts'),
    hit('src/lib/persistence.ts'),
    hit('test/yi/setup.ts'),
    hit('test/yi/smoke.test.ts'),
    hit('test/yi/persistence/store.test.ts'),
    hit('src/yi/', true),
    hit('test/yi/', true),
    hit('test/yi/plugins/', true),
    hit('test/yi/persistence/', true),
  ];

  test('yi.ts prefers source files over the test/yi tree', () => {
    const ranked = rankFileMentionSearch(project, 'yi.ts', { limit: 10 }).map((item) => item.relativePath);
    expect(ranked[0]).toBe('src/yi.ts');
    expect(ranked.slice(0, 3)).toEqual(['src/yi.ts', 'packages/core/src/yi.ts', 'src/yi/index.ts']);
    expect(ranked.indexOf('src/yi.ts')).toBeLessThan(ranked.indexOf('test/yi/setup.ts'));
    expect(ranked.indexOf('src/yi/index.ts')).toBeLessThan(ranked.indexOf('src/yi.test.ts'));
  });

  test('yi/ prefers directories, source dir first', () => {
    const ranked = rankFileMentionSearch(project, 'yi/', { limit: 10 }).map((item) => item.relativePath);
    expect(ranked[0]).toBe('src/yi/');
    expect(ranked[1]).toBe('test/yi/');
    expect(ranked.indexOf('src/yi/')).toBeLessThan(ranked.indexOf('src/yi.ts'));
  });

  test('persistence/ prefers the directory over persistence.ts', () => {
    const ranked = rankFileMentionSearch(project, 'persistence/', { limit: 10 }).map((item) => item.relativePath);
    expect(ranked[0]).toBe('test/yi/persistence/');
    expect(ranked.indexOf('test/yi/persistence/')).toBeLessThan(ranked.indexOf('src/lib/persistence.ts'));
  });
});

describe('file mention query intent', () => {
  test('parses file, directory, and plain identifier queries', () => {
    expect(parseFileMentionQuery('yi.ts')).toEqual({
      raw: 'yi.ts',
      search: 'yi.ts',
      stem: 'yi',
      extension: 'ts',
      fileIntent: true,
      directoryIntent: false,
    });
    expect(parseFileMentionQuery('yi/')).toEqual({
      raw: 'yi/',
      search: 'yi',
      stem: 'yi',
      extension: null,
      fileIntent: false,
      directoryIntent: true,
    });
    expect(resolveFileMentionSearchQuery('yi.ts')).toBe('yi');
    expect(resolveFileMentionSearchQuery('yi/')).toBe('yi');
    expect(resolveFileMentionSearchQuery('config')).toBe('config');
  });

  test('detects test paths without treating source filenames as tests', () => {
    expect(isTestFileMentionPath('test/yi/setup.ts')).toBe(true);
    expect(isTestFileMentionPath('src/yi.test.ts')).toBe(true);
    expect(isTestFileMentionPath('packages/ui/src/yi.ts')).toBe(false);
    expect(isTestFileMentionPath('contest.ts')).toBe(false);
  });
});
