import { describe, expect, test } from 'bun:test';
import {
  clearActiveChatInputSurface,
  getActiveChatInputSurface,
  isChatComposerMainTab,
  setActiveChatInputSurface,
} from './activeChatInputSurface';
import type { ChatInputSurface } from './chatInputSurface';

const surface = (surfaceID: string): ChatInputSurface => ({
  kind: 'secondary',
  surfaceID,
  active: true,
  sessionID: 'ses_test',
  directory: '/workspace',
  draftKey: { transportIdentity: 'local', owner: { kind: 'surface', ownerID: surfaceID } },
  transportIdentity: 'local',
  runtimeGeneration: 1,
  deliveryTarget: { kind: 'assistant', assistantID: 'asst_test' },
  selection: {
    value: { providerID: 'p', modelID: 'm', agent: 'build' },
    flush: async () => {},
  },
  backend: {
    send: async () => {},
    sendQueued: async () => {},
    create: async () => {},
    compact: async () => {},
    abort: async () => {},
  },
  shortcuts: {
    cycle: () => {},
    new: () => {},
    abort: () => {},
    submit: () => {},
  },
  activity: { phase: 'idle' },
  commands: { sessionID: 'ses_test', hasMessages: false, hasNewDraft: false },
  resources: {
    busy: false,
    attachments: [],
    addAttachment: async () => {},
    removeAttachment: () => {},
    clearAttachments: () => {},
    setAttachments: () => {},
    pendingInput: null,
    consumePendingInput: () => null,
    pendingPreset: null,
    consumePendingPreset: () => null,
    consumeSyntheticParts: () => null,
    restoreSyntheticParts: () => {},
    inlineDrafts: [],
    removeInlineDraft: () => {},
    restoreInlineDrafts: () => {},
    history: [],
    captureRuntime: () => ({ transportIdentity: 'local', generation: 1 }),
    getDraft: () => undefined,
    abortPrompt: { sessionID: null, clear: () => {} },
  },
});

describe('activeChatInputSurface', () => {
  test('treats chat and assistant tabs as composer tabs', () => {
    expect(isChatComposerMainTab('chat')).toBe(true);
    expect(isChatComposerMainTab('assistant')).toBe(true);
    expect(isChatComposerMainTab('scheduled')).toBe(false);
  });

  test('tracks the active mounted composer surface', () => {
    clearActiveChatInputSurface();
    const next = surface('assistant:one');
    setActiveChatInputSurface(next);
    expect(getActiveChatInputSurface()?.surfaceID).toBe('assistant:one');
    clearActiveChatInputSurface('assistant:other');
    expect(getActiveChatInputSurface()?.surfaceID).toBe('assistant:one');
    clearActiveChatInputSurface('assistant:one');
    expect(getActiveChatInputSurface()).toBeNull();
  });
});
