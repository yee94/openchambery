import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveSessionIndexDbPath } from './resolve-db-path.js';

describe('resolveSessionIndexDbPath', () => {
  const dataDir = '/home/user/.config/yuri';
  const defaultExpect = path.join(dataDir, 'session-index.sqlite');

  it('returns default path when options are empty', () => {
    expect(resolveSessionIndexDbPath({}, dataDir)).toBe(defaultExpect);
  });

  it('returns default path when sessionIndexDbPath is undefined', () => {
    expect(resolveSessionIndexDbPath({ sessionIndexDbPath: undefined }, dataDir)).toBe(defaultExpect);
  });

  it('returns null when sessionIndexDbPath is explicitly null', () => {
    expect(resolveSessionIndexDbPath({ sessionIndexDbPath: null }, dataDir)).toBeNull();
  });

  it('returns the explicit string path', () => {
    expect(resolveSessionIndexDbPath({ sessionIndexDbPath: '/custom/path.db' }, dataDir)).toBe('/custom/path.db');
  });

  it('falls back to default when sessionIndexDbPath is an empty string', () => {
    expect(resolveSessionIndexDbPath({ sessionIndexDbPath: '' }, dataDir)).toBe(defaultExpect);
  });

  it('falls back to default when sessionIndexDbPath is a whitespace-only string', () => {
    expect(resolveSessionIndexDbPath({ sessionIndexDbPath: '   ' }, dataDir)).toBe(defaultExpect);
  });

  it('returns null when dataDir is empty and no explicit path', () => {
    expect(resolveSessionIndexDbPath({}, '')).toBeNull();
  });

  it('returns null when dataDir is not a string and no explicit path', () => {
    expect(resolveSessionIndexDbPath({}, undefined)).toBeNull();
  });

  it('ignores dataDir when explicit null is provided', () => {
    expect(resolveSessionIndexDbPath({ sessionIndexDbPath: null }, dataDir)).toBeNull();
  });

  it('handles options undefined gracefully (defaults to default path)', () => {
    expect(resolveSessionIndexDbPath(undefined, dataDir)).toBe(defaultExpect);
  });
});
