import { describe, expect, test } from 'vitest';

import { splitFileNameExt, splitTruncatedPath } from './truncatePathDisplay';

describe('splitFileNameExt', () => {
  test('keeps the last suffix including the dot', () => {
    expect(splitFileNameExt('plugin.ts')).toEqual({ stem: 'plugin', ext: '.ts' });
    expect(splitFileNameExt('file.d.ts')).toEqual({ stem: 'file.d', ext: '.ts' });
  });

  test('does not split dotfiles or names without a suffix', () => {
    expect(splitFileNameExt('.gitignore')).toEqual({ stem: '.gitignore', ext: '' });
    expect(splitFileNameExt('Makefile')).toEqual({ stem: 'Makefile', ext: '' });
    expect(splitFileNameExt('file.')).toEqual({ stem: 'file.', ext: '' });
  });
});

describe('splitTruncatedPath', () => {
  test('keeps the parent directory and file suffix as the -2 tail', () => {
    expect(
      splitTruncatedPath('app/wxaaiagentnodelogicsvr/src/mmpMethod/plugin.ts'),
    ).toEqual({
      prefix: 'app/wxaaiagentnodelogicsvr/src',
      parent: 'mmpMethod',
      stem: 'plugin',
      ext: '.ts',
      name: 'plugin.ts',
      leadingSlash: false,
    });
  });

  test('keeps only the filename when the path has one segment', () => {
    expect(splitTruncatedPath('buildGreetingPrefix.ts')).toEqual({
      prefix: '',
      parent: '',
      stem: 'buildGreetingPrefix',
      ext: '.ts',
      name: 'buildGreetingPrefix.ts',
      leadingSlash: false,
    });
  });

  test('keeps the parent when the path has two segments', () => {
    expect(splitTruncatedPath('skillPreload/buildGreetingPrefix.ts')).toEqual({
      prefix: '',
      parent: 'skillPreload',
      stem: 'buildGreetingPrefix',
      ext: '.ts',
      name: 'buildGreetingPrefix.ts',
      leadingSlash: false,
    });
  });

  test('preserves a leading slash on the prefix', () => {
    expect(splitTruncatedPath('/Users/foo/src/plugin.ts')).toEqual({
      prefix: '/Users/foo',
      parent: 'src',
      stem: 'plugin',
      ext: '.ts',
      name: 'plugin.ts',
      leadingSlash: false,
    });
  });

  test('keeps a leading slash glyph when the prefix is empty', () => {
    expect(splitTruncatedPath('/plugin.ts')).toEqual({
      prefix: '',
      parent: '',
      stem: 'plugin',
      ext: '.ts',
      name: 'plugin.ts',
      leadingSlash: true,
    });
    expect(splitTruncatedPath('/src/plugin.ts')).toEqual({
      prefix: '',
      parent: 'src',
      stem: 'plugin',
      ext: '.ts',
      name: 'plugin.ts',
      leadingSlash: true,
    });
  });
});
