import { describe, expect, it } from 'vitest';
import { guiPreferencesKey, readDisabledPlugins, writePluginEnabled } from './preferences';

describe('GUI enable-state', () => {
  it('partitions hosts and round-trips enabled/disabled independently', () => {
    const one = guiPreferencesKey('host-one');
    const two = guiPreferencesKey('host-two');
    localStorage.clear();
    expect(writePluginEnabled(localStorage, one, 'dsl', false)).toEqual(['dsl']);
    expect(readDisabledPlugins(localStorage, two)).toEqual([]);
    expect(writePluginEnabled(localStorage, one, 'dsl', true)).toEqual([]);
  });
  it('does not claim success on malformed state or failed persistent writes', () => {
    expect(() => readDisabledPlugins({ getItem: () => '{broken' }, 'key')).toThrow();
    expect(() => readDisabledPlugins({ getItem: () => '[true]' }, 'key')).toThrow('Invalid GUI');
    expect(() => writePluginEnabled({ getItem: () => '[]', setItem: () => { throw new Error('quota'); } }, 'key', 'dsl', false)).toThrow('quota');
  });
});
