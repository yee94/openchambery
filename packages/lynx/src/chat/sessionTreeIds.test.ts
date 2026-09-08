import { describe, expect, test } from 'vitest';

import {
  collectLynxSessionTreeIds,
  getLynxParentId,
  resolveLynxSessionTreeTargets,
} from './sessionTreeIds';

describe('collectLynxSessionTreeIds', () => {
  test('getLynxParentId mirrors Cap parentID', () => {
    expect(getLynxParentId({ id: 'a', parentID: 'root' })).toBe('root');
    expect(getLynxParentId({ id: 'a', parentID: '  ' })).toBe(null);
    expect(getLynxParentId({ id: 'a', parentID: null })).toBe(null);
    expect(getLynxParentId(null)).toBe(null);
  });

  test('collects root + descendants via parentID (Cap spirit)', () => {
    const sessions = [
      { id: 'root', parentID: null },
      { id: 'child-a', parentID: 'root' },
      { id: 'child-b', parentID: 'root' },
      { id: 'grand', parentID: 'child-a' },
      { id: 'other', parentID: null },
      { id: 'orphan', parentID: 'missing' },
    ];
    expect(collectLynxSessionTreeIds('root', sessions)).toEqual([
      'root',
      'child-a',
      'grand',
      'child-b',
    ]);
    expect(collectLynxSessionTreeIds('child-a', sessions)).toEqual(['child-a', 'grand']);
    expect(collectLynxSessionTreeIds('other', sessions)).toEqual(['other']);
  });

  test('skips cycles and empty root', () => {
    expect(collectLynxSessionTreeIds('  ', [])).toEqual([]);
    const cyclic = [
      { id: 'a', parentID: 'b' },
      { id: 'b', parentID: 'a' },
    ];
    expect(collectLynxSessionTreeIds('a', cyclic)).toEqual(['a', 'b']);
  });

  test('resolveLynxSessionTreeTargets includes directories', () => {
    const map = new Map([
      ['root', { id: 'root', parentID: null, directory: '/repo' }],
      ['child', { id: 'child', parentID: 'root', directory: '/repo/wt' }],
    ]);
    expect(resolveLynxSessionTreeTargets({ sessionId: 'root', directory: '/repo' }, map)).toEqual([
      { sessionId: 'root', directory: '/repo' },
      { sessionId: 'child', directory: '/repo/wt' },
    ]);
  });
});
