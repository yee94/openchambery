import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import { buildSessionMessageRecordsSnapshot } from './sync-context';
import { INITIAL_STATE, type State } from './types';

const message = (id: string, role: 'user' | 'assistant', parentID?: string): Message => ({
  id,
  role,
  sessionID: 'ses_1',
  ...(parentID ? { parentID } : {}),
  time: { created: 1 },
} as Message);

const textPart = (id: string, text: string): Part => ({
  id,
  type: 'text',
  text,
} as Part);

const state = (partial: Partial<State>): State => ({
  ...INITIAL_STATE,
  ...partial,
});

describe('buildSessionMessageRecordsSnapshot', () => {
  test('only suspends part updates for the active streaming message', () => {
    const user = message('user_1', 'user');
    const assistant1 = message('assistant_1', 'assistant', 'user_1');
    const assistant2 = message('assistant_2', 'assistant', 'user_1');
    const messages = [user, assistant1, assistant2];
    const assistant1InitialParts = [textPart('assistant_1_text', 'initial')];
    const assistant2InitialParts = [textPart('assistant_2_text', 'initial')];

    const previous = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: {
          assistant_1: assistant1InitialParts,
          assistant_2: assistant2InitialParts,
        },
      }),
      'ses_1',
      undefined,
      true,
      'assistant_1',
    );

    // Same part ids: non-suspended assistant_1 takes live text; suspended
    // assistant_2 freezes pure text growth. New part ids would still admit live
    // (structural change) — covered by the tool-admission test below.
    const assistant1FinalParts = [textPart('assistant_1_text', 'final')];
    const assistant2LiveParts = [textPart('assistant_2_text', 'live')];
    const next = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: {
          assistant_1: assistant1FinalParts,
          assistant_2: assistant2LiveParts,
        },
      }),
      'ses_1',
      previous,
      true,
      'assistant_2',
    );

    expect(next.byId.get('assistant_1')?.parts).toBe(assistant1FinalParts);
    expect(next.byId.get('assistant_2')?.parts).toBe(assistant2InitialParts);
  });

  test('admits new tool parts on the suspended streaming message', () => {
    const user = message('user_1', 'user');
    const assistant1 = message('assistant_1', 'assistant', 'user_1');
    const messages = [user, assistant1];
    const reasoning = textPart('reason_1', 'thinking');
    const previous = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: { assistant_1: [reasoning] },
      }),
      'ses_1',
      undefined,
      true,
      'assistant_1',
    );

    const tool = {
      id: 'tool_1',
      type: 'tool',
      tool: 'read',
      state: { status: 'running' },
    } as Part;
    const next = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: { assistant_1: [reasoning, tool] },
      }),
      'ses_1',
      previous,
      true,
      'assistant_1',
    );

    expect(next.byId.get('assistant_1')?.parts.map((part) => part.id)).toEqual([
      'reason_1',
      'tool_1',
    ]);
  });

  test('still freezes pure text growth on the suspended streaming message', () => {
    const user = message('user_1', 'user');
    const assistant1 = message('assistant_1', 'assistant', 'user_1');
    const messages = [user, assistant1];
    const initial = [textPart('t1', 'Hel')];
    const previous = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: { assistant_1: initial },
      }),
      'ses_1',
      undefined,
      true,
      'assistant_1',
    );

    const grown = [textPart('t1', 'Hello world')];
    const next = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: { assistant_1: grown },
      }),
      'ses_1',
      previous,
      true,
      'assistant_1',
    );

    expect(next.byId.get('assistant_1')?.parts).toBe(initial);
    expect((next.byId.get('assistant_1')?.parts[0] as { text?: string })?.text).toBe('Hel');
  });
});
