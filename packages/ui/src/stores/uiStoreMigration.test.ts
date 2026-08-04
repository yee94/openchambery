import { describe, expect, test } from 'bun:test';
import {
  COMPACT_CHAT_DEFAULTS_PERSIST_VERSION,
  migrateCompactChatDefaultsForPersistVersion,
} from './uiStoreMigration';

describe('migrateCompactChatDefaultsForPersistVersion', () => {
  test('upgrades v11 legacy defaults to compact-chat defaults', () => {
    const state = {
      chatRenderMode: 'live' as const,
      activityRenderMode: 'summary' as const,
      showTurnChangedFiles: false,
      theme: 'dark',
    };

    const result = migrateCompactChatDefaultsForPersistVersion(state, 11);

    expect(result).toBe(state);
    expect(result).toEqual({
      chatRenderMode: 'sorted',
      activityRenderMode: 'collapsed',
      showTurnChangedFiles: true,
      theme: 'dark',
    });
  });

  test('upgrades each legacy default field independently', () => {
    expect(
      migrateCompactChatDefaultsForPersistVersion({ chatRenderMode: 'live' }, 11).chatRenderMode,
    ).toBe('sorted');
    expect(
      migrateCompactChatDefaultsForPersistVersion({ activityRenderMode: 'summary' }, 10)
        .activityRenderMode,
    ).toBe('collapsed');
    expect(
      migrateCompactChatDefaultsForPersistVersion({ showTurnChangedFiles: false }, 0)
        .showTurnChangedFiles,
    ).toBe(true);
  });

  test('preserves non-legacy values on pre-v12 state', () => {
    const state = {
      chatRenderMode: 'sorted' as const,
      activityRenderMode: 'collapsed' as const,
      showTurnChangedFiles: true,
    };

    expect(migrateCompactChatDefaultsForPersistVersion(state, 11)).toEqual(state);
  });

  test('does not re-upgrade after v12 even when values match legacy defaults', () => {
    const state = {
      chatRenderMode: 'live' as const,
      activityRenderMode: 'summary' as const,
      showTurnChangedFiles: false,
    };

    const result = migrateCompactChatDefaultsForPersistVersion(
      { ...state },
      COMPACT_CHAT_DEFAULTS_PERSIST_VERSION,
    );

    expect(result).toEqual(state);

    const afterUserChoice = migrateCompactChatDefaultsForPersistVersion(
      { ...state },
      COMPACT_CHAT_DEFAULTS_PERSIST_VERSION + 1,
    );
    expect(afterUserChoice).toEqual(state);
  });
});
