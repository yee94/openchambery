import { describe, expect, test } from 'bun:test';

import { arePathsEquivalent, normalizeDirectoryKey, normalizePath } from './pathNormalization';

describe('normalizePath', () => {
  describe('non-string inputs', () => {
    test('returns null for null', () => {
      expect(normalizePath(null)).toBeNull();
    });

    test('returns null for undefined', () => {
      expect(normalizePath(undefined)).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(normalizePath('')).toBeNull();
    });

    test('returns null for whitespace-only', () => {
      expect(normalizePath('   ')).toBeNull();
    });
  });

  describe('backslashes', () => {
    test('converts backslashes to forward slashes', () => {
      expect(normalizePath('C:\\Users\\me\\project')).toBe('C:/Users/me/project');
    });
  });

  describe('drive letter casing', () => {
    test('uppercases lowercase Windows drive letter', () => {
      expect(normalizePath('c:\\Users\\me\\project')).toBe('C:/Users/me/project');
    });

    test('preserves already-uppercase drive letter', () => {
      expect(normalizePath('C:\\Users\\me\\project')).toBe('C:/Users/me/project');
    });

    test('does not match multi-character tokens before colon', () => {
      expect(normalizePath('abc:def')).toBe('abc:def');
    });

    test('does not touch drive letter in middle of path', () => {
      // Only the leading drive letter is touched; a "c:" later in the
      // path is left alone (no upper-casing, no backslash conversion of
      // the surrounding characters beyond the backslash-to-slash step).
      expect(normalizePath('/foo/c:\\bar')).toBe('/foo/c:/bar');
    });
  });

  describe('trailing slashes', () => {
    test('strips a single trailing slash', () => {
      expect(normalizePath('C:/Users/me/')).toBe('C:/Users/me');
    });

    test('strips multiple trailing slashes', () => {
      expect(normalizePath('C:/Users/me///')).toBe('C:/Users/me');
    });

    test('preserves root /', () => {
      expect(normalizePath('/')).toBe('/');
    });

    test('preserves single-char after slash strip', () => {
      expect(normalizePath('C:/')).toBe('C:');
    });
  });

  describe('degenerate slash-only inputs', () => {
    // '///' → stays '///' after backslash replace → trailing-slash strip
    // yields '' → null. This is the new defensive behavior.
    test('returns null for multiple forward slashes', () => {
      expect(normalizePath('///')).toBeNull();
    });

    // '\\\\' in source = 2 backslash chars → replace to '//' → strip → '' → null.
    test('returns null for multiple backslashes', () => {
      expect(normalizePath('\\\\')).toBeNull();
    });

    // A single backslash '\\' is normalized to a single forward slash
    // and treated as the filesystem root, returned as '/'. (This is the
    // pre-existing behavior; the defensive fix only adds null for
    // slash-only inputs that strip down to ''.)
    test('normalizes a single backslash to the root "/"', () => {
      expect(normalizePath('\\')).toBe('/');
    });
  });

  describe('Unix paths', () => {
    test('passes through a Unix path unchanged', () => {
      expect(normalizePath('/home/user/project')).toBe('/home/user/project');
    });

    test('strips trailing slashes from Unix paths', () => {
      expect(normalizePath('/home/user/project/')).toBe('/home/user/project');
    });
  });

  describe('Windows UNC and device paths', () => {
    test('keeps a UNC share rooted on two slashes', () => {
      expect(normalizePath('\\\\server\\share\\dir')).toBe('//server/share/dir');
    });

    test('keeps an already-normalized UNC share intact', () => {
      expect(normalizePath('//server/share/dir')).toBe('//server/share/dir');
    });

    test('keeps a \\\\?\\ device path addressable', () => {
      expect(normalizePath('\\\\?\\C:\\x')).toBe('//?/C:/x');
    });
  });

  describe('relative segments', () => {
    test('resolves parent segments', () => {
      expect(normalizePath('C:/a/../b')).toBe('C:/b');
    });

    test('collapses duplicate separators inside a path', () => {
      expect(normalizePath('/home//user///project')).toBe('/home/user/project');
    });
  });
});

describe('normalizeDirectoryKey', () => {
  test('agrees with normalizePath for usable input', () => {
    expect(normalizeDirectoryKey('c:\\Users\\me\\project\\')).toBe('C:/Users/me/project');
  });

  test('collapses every spelling of one directory onto one key', () => {
    const spellings = [
      'c:\\Users\\me\\project',
      'C:\\Users\\me\\project',
      'C:/Users/me/project',
      'C:/Users/me/project/',
      'C:/Users/me/other/../project',
    ];
    const keys = new Set(spellings.map((spelling) => normalizeDirectoryKey(spelling)));
    expect(keys.size).toBe(1);
  });

  test('is total — degenerate input degrades to itself rather than merging', () => {
    // normalizePath rejects these; a key must still exist and must stay distinct.
    expect(normalizeDirectoryKey('///')).toBe('///');
    expect(normalizeDirectoryKey('\\\\')).toBe('\\\\');
    expect(normalizeDirectoryKey('///')).not.toBe(normalizeDirectoryKey('\\\\'));
  });

  test('returns an empty key for absent input', () => {
    expect(normalizeDirectoryKey(null)).toBe('');
    expect(normalizeDirectoryKey(undefined)).toBe('');
    expect(normalizeDirectoryKey('   ')).toBe('');
  });

  test('does not case-fold beyond the drive letter', () => {
    expect(normalizeDirectoryKey('C:/Users/Me')).not.toBe(normalizeDirectoryKey('C:/Users/me'));
  });
});

describe('arePathsEquivalent', () => {
  test('matches across separator, drive case and trailing slash', () => {
    expect(arePathsEquivalent('c:\\Users\\me\\project\\', 'C:/Users/me/project')).toBe(true);
  });

  test('does not match different directories', () => {
    expect(arePathsEquivalent('/home/a', '/home/b')).toBe(false);
  });

  test('never matches on unusable input', () => {
    expect(arePathsEquivalent(null, null)).toBe(false);
    expect(arePathsEquivalent('', '')).toBe(false);
  });
});
