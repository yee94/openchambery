import { describe, expect, test } from 'vitest';

import {
  LynxAssistantParseError,
  parseLynxAssistantDTO,
  parseLynxAssistantReadPosition,
  parseLynxAssistantReadResponse,
  parseLynxAssistantSnapshot,
} from './parse';

const baseAssistant = {
  id: 'asst_1',
  revision: 1,
  enabled: true,
  name: 'Helper',
  defaultPrompt: 'hi',
  workspacePath: '/repo',
  effectiveWorkspacePath: '/repo',
  managedWorkspacePath: null,
  providerID: 'anthropic',
  modelID: 'claude',
  agent: null,
  variant: null,
  mode: 'continuous',
  sessionID: 'ses_1',
  sessionGeneration: 2,
  historySessionIDs: ['ses_0'],
  historySessionCount: 1,
  createdAt: null,
  updatedAt: 2,
  tombstoneAt: null,
};

const tip = { generation: 3, ordinal: 7, messageID: 'msg_tip' };

describe('Lynx assistant unread parse', () => {
  test('defaults unreadCount to 0 when Cap fields are absent', () => {
    const dto = parseLynxAssistantDTO(baseAssistant);
    expect(dto.unreadCount).toBe(0);
    expect(dto.readTip).toBeNull();
    expect(dto.readWatermark).toBeNull();
  });

  test('parses unreadCount + nullable readTip / readWatermark', () => {
    const dto = parseLynxAssistantDTO({
      ...baseAssistant,
      unreadCount: 4,
      readTip: tip,
      readWatermark: { generation: 1, ordinal: 0, messageID: 'msg_wm' },
    });
    expect(dto.unreadCount).toBe(4);
    expect(dto.readTip).toEqual(tip);
    expect(dto.readWatermark).toEqual({ generation: 1, ordinal: 0, messageID: 'msg_wm' });
  });

  test('rejects malformed unreadCount (negative, float, non-number)', () => {
    expect(() => parseLynxAssistantDTO({ ...baseAssistant, unreadCount: -1 })).toThrow(LynxAssistantParseError);
    expect(() => parseLynxAssistantDTO({ ...baseAssistant, unreadCount: 1.5 })).toThrow(LynxAssistantParseError);
    expect(() => parseLynxAssistantDTO({ ...baseAssistant, unreadCount: '2' })).toThrow(LynxAssistantParseError);
    expect(() => parseLynxAssistantDTO({ ...baseAssistant, unreadCount: null })).toThrow(LynxAssistantParseError);
  });

  test('rejects malformed readTip / readWatermark positions', () => {
    expect(() => parseLynxAssistantDTO({ ...baseAssistant, readTip: {} })).toThrow(LynxAssistantParseError);
    expect(() => parseLynxAssistantDTO({
      ...baseAssistant,
      readTip: { generation: -1, ordinal: 0, messageID: 'm' },
    })).toThrow(LynxAssistantParseError);
    expect(() => parseLynxAssistantDTO({
      ...baseAssistant,
      readWatermark: { generation: 1, ordinal: 2, messageID: 9 },
    })).toThrow(LynxAssistantParseError);
  });

  test('parseLynxAssistantReadPosition matches Cap generation/ordinal/messageID', () => {
    expect(parseLynxAssistantReadPosition(tip)).toEqual(tip);
    expect(() => parseLynxAssistantReadPosition({ generation: 1, ordinal: 1 })).toThrow(LynxAssistantParseError);
  });

  test('parseLynxAssistantReadResponse requires a complete Cap read payload', () => {
    const parsed = parseLynxAssistantReadResponse({
      assistantID: 'asst_1',
      changed: true,
      unreadCount: 0,
      readWatermark: tip,
      readTip: tip,
      revision: 8,
    });
    expect(parsed.assistantID).toBe('asst_1');
    expect(parsed.unreadCount).toBe(0);
    expect(() => parseLynxAssistantReadResponse({
      assistantID: 'asst_1',
      changed: true,
      unreadCount: 0,
    })).toThrow(LynxAssistantParseError);
  });

  test('snapshot parse carries unread fields through assistants', () => {
    const snapshot = parseLynxAssistantSnapshot({
      revision: 3,
      enabled: true,
      assistants: [{ ...baseAssistant, unreadCount: 2, readTip: tip }],
    });
    expect(snapshot.assistants[0]?.unreadCount).toBe(2);
    expect(snapshot.assistants[0]?.readTip).toEqual(tip);
  });
});
