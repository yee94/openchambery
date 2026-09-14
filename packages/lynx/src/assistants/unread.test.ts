import { describe, expect, test } from 'vitest';

import type { LynxAssistantDTO, LynxAssistantSnapshot } from './types';
import {
  formatLynxAssistantUnreadBadge,
  lynxAssistantsEligibleForMarkAll,
  resolveLynxAssistantOpenReadPosition,
  selectLynxAssistantUnreadTotal,
} from './unread';

const tip = { generation: 1, ordinal: 2, messageID: 'msg_1' };

const assistant = (overrides: Partial<LynxAssistantDTO> = {}): LynxAssistantDTO => ({
  id: 'asst_1',
  revision: 1,
  enabled: true,
  name: 'Helper',
  defaultPrompt: '',
  workspacePath: null,
  effectiveWorkspacePath: '/repo',
  managedWorkspacePath: null,
  providerID: 'anthropic',
  modelID: 'claude',
  agent: null,
  variant: null,
  mode: 'continuous',
  sessionID: 'ses_1',
  sessionGeneration: 1,
  historySessionIDs: [],
  historySessionCount: 0,
  createdAt: null,
  updatedAt: 1,
  tombstoneAt: null,
  unreadCount: 0,
  readTip: null,
  readWatermark: null,
  ...overrides,
});

describe('Lynx assistant unread badge', () => {
  test('hides zero and non-positive counts', () => {
    expect(formatLynxAssistantUnreadBadge(0)).toEqual({ visible: false, display: '', count: 0 });
    expect(formatLynxAssistantUnreadBadge(-3).visible).toBe(false);
  });

  test('shows exact count through 99 and caps at 99+', () => {
    expect(formatLynxAssistantUnreadBadge(1)).toEqual({ visible: true, display: '1', count: 1 });
    expect(formatLynxAssistantUnreadBadge(99)).toEqual({ visible: true, display: '99', count: 99 });
    expect(formatLynxAssistantUnreadBadge(100)).toEqual({ visible: true, display: '99+', count: 100 });
    expect(formatLynxAssistantUnreadBadge(250)).toEqual({ visible: true, display: '99+', count: 250 });
  });
});

describe('Lynx assistant unread totals / mark-all eligibility', () => {
  test('selectLynxAssistantUnreadTotal sums enabled catalog only', () => {
    const enabled: LynxAssistantSnapshot = {
      revision: 1,
      enabled: true,
      assistants: [
        assistant({ id: 'a', unreadCount: 2 }),
        assistant({ id: 'b', unreadCount: 5 }),
      ],
    };
    expect(selectLynxAssistantUnreadTotal(enabled)).toBe(7);
    expect(selectLynxAssistantUnreadTotal({ ...enabled, enabled: false })).toBe(0);
  });

  test('mark-all targets require unreadCount > 0 and a readTip', () => {
    const snapshot: LynxAssistantSnapshot = {
      revision: 1,
      enabled: true,
      assistants: [
        assistant({ id: 'with-tip', unreadCount: 3, readTip: tip }),
        assistant({ id: 'no-tip', unreadCount: 4, readTip: null }),
        assistant({ id: 'zero', unreadCount: 0, readTip: tip }),
      ],
    };
    expect(lynxAssistantsEligibleForMarkAll(snapshot)).toEqual([
      { id: 'with-tip', position: tip },
    ]);
  });

  test('open/latest-visible mark uses snapshot readTip only when viewing', () => {
    expect(resolveLynxAssistantOpenReadPosition({ viewing: true, readTip: tip })).toEqual(tip);
    expect(resolveLynxAssistantOpenReadPosition({ viewing: false, readTip: tip })).toBeNull();
    expect(resolveLynxAssistantOpenReadPosition({ viewing: true, readTip: null })).toBeNull();
  });
});
