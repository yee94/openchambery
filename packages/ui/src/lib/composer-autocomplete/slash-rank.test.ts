import { describe, expect, test } from 'vitest';

import { rankCommandsForQuery } from './slash-rank';

describe('rankCommandsForQuery', () => {
  const commands = [
    { name: 'loop', description: 'repeat a prompt', isBuiltIn: false },
    { name: 'undo', description: 'restore the previous turn', isBuiltIn: true },
    { name: 'new', description: 'start a session', isBuiltIn: true },
  ];

  test('lists built-ins first when the query is empty', () => {
    expect(rankCommandsForQuery(commands, '').map((item) => item.name)).toEqual([
      'new',
      'undo',
      'loop',
    ]);
  });

  test('fuzzy-matches name and description', () => {
    expect(rankCommandsForQuery(commands, 'und')[0]?.name).toBe('undo');
    expect(rankCommandsForQuery(commands, 'repeat')[0]?.name).toBe('loop');
  });
});
