import { describe, expect, test } from 'vitest';

import {
  assignLynxShareDraftRecipient,
  buildLynxShareCatalogEntries,
  isAssignedLynxShareDraft,
  sortLynxShareRecipientEntries,
  type LynxShareCatalogEntry,
  type LynxShareDraft,
} from './shareDraft';

const baseDraft = (): LynxShareDraft => ({
  version: 1,
  draftID: 'draft-1',
  text: 'hello',
  attachments: [],
  source: 'android-share',
  createdAt: 1,
  expiresAt: 9_999_999_999_999,
});

const entry = (overrides: Partial<LynxShareCatalogEntry> = {}): LynxShareCatalogEntry => ({
  serverInstanceID: 'srv',
  assistantID: 'asst-1',
  name: 'Alpha',
  avatarSeed: 'asst-1',
  serverLabel: 'Home',
  connectionKey: 'conn-1',
  enabled: true,
  isDefaultShareTarget: false,
  ...overrides,
});

describe('lynx share draft recipient helpers', () => {
  test('unassigned drafts are not assigned; assign fills exact target', () => {
    const draft = baseDraft();
    expect(isAssignedLynxShareDraft(draft)).toBe(false);
    const assigned = assignLynxShareDraftRecipient(draft, entry());
    expect(isAssignedLynxShareDraft(assigned)).toBe(true);
    expect(assigned.assistantID).toBe('asst-1');
    expect(assigned.connectionKey).toBe('conn-1');
    expect(assigned.serverLabel).toBe('Home');
  });

  test('catalog builder never marks a silent default share target', () => {
    const entries = buildLynxShareCatalogEntries({
      capability: {
        supported: true,
        enabled: true,
        revision: 1,
        serverInstanceID: 'srv',
      },
      assistants: [
        {
          id: 'a1',
          revision: 1,
          enabled: true,
          name: 'One',
          defaultPrompt: '',
          workspacePath: null,
          effectiveWorkspacePath: '/',
          managedWorkspacePath: null,
          providerID: 'p',
          modelID: 'm',
          agent: null,
          variant: null,
          mode: 'continuous',
          sessionID: null,
          sessionGeneration: 0,
          historySessionIDs: [],
          historySessionCount: 0,
          createdAt: null,
          updatedAt: 1,
          tombstoneAt: null,
        },
      ],
      connectionKey: 'ck',
      serverLabel: 'Lab',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.isDefaultShareTarget).toBe(false);
    expect(entries[0]?.serverLabel).toBe('Lab');
  });

  test('sort keeps enabled only and never invents default', () => {
    const sorted = sortLynxShareRecipientEntries([
      entry({ assistantID: 'b', name: 'Beta', enabled: false }),
      entry({ assistantID: 'a', name: 'Alpha', serverLabel: 'Zed' }),
      entry({ assistantID: 'c', name: 'Gamma', serverLabel: 'Ace' }),
    ]);
    expect(sorted.map((item) => item.assistantID)).toEqual(['c', 'a']);
  });
});
