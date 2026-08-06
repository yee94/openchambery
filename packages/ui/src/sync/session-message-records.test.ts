import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import {
  buildSessionMessageRecordsSnapshot,
  buildSessionMessageRecordsSnapshotFromSource,
} from './sync-context';
import { messagesFromTranscriptData } from './transcript-repository-observers';
import type { TranscriptData } from './transcript-repository';
import type { State } from './types';
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from './types';

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

/** Test-local projection surface (not production State). */
const state = (partial: {
  session?: State['session'];
  message?: Record<string, Message[]>;
  part?: Record<string, Part[]>;
}) => ({
  session: [] as State['session'],
  message: {} as Record<string, Message[]>,
  part: {} as Record<string, Part[]>,
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

  test('buildSessionMessageRecordsSnapshotFromSource matches store-shaped builder', () => {
    const user = message('user_1', 'user');
    const assistant1 = message('assistant_1', 'assistant', 'user_1');
    const messages = [user, assistant1];
    const parts = {
      assistant_1: [textPart('t1', 'hello')],
    };
    const fromState = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: parts,
      }),
      'ses_1',
    );
    const fromSource = buildSessionMessageRecordsSnapshotFromSource({
      sessionID: 'ses_1',
      messages,
      parts,
    });
    expect(fromSource.list.map((record) => record.info.id)).toEqual(
      fromState.list.map((record) => record.info.id),
    );
    expect(fromSource.list[1]?.parts).toEqual(fromState.list[1]?.parts);
  });

  test('consecutive reads of the same non-empty TranscriptData keep list reference stable', () => {
    const user = message('user_1', 'user');
    const assistant1 = message('assistant_1', 'assistant', 'user_1');
    const parts = {
      assistant_1: [textPart('t1', 'hello')],
    };
    const data: TranscriptData = {
      sessionID: 'ses_1',
      messageOrder: ['user_1', 'assistant_1'],
      messagesByID: { user_1: user, assistant_1: assistant1 },
      partsByMessageID: parts,
      boundary: UNKNOWN_SESSION_HISTORY_BOUNDARY,
      liveRevision: 0,
    };

    // Simulate useSessionMessageRecords getSnapshot: pass previous sourceMessages
    // so messagesFromTranscriptData reuses the array and the records snapshot stays
    // Object.is-stable across React tearing double-reads.
    let previousSourceMessages: Message[] | undefined;
    let previousSnapshot: ReturnType<typeof buildSessionMessageRecordsSnapshotFromSource> | undefined;

    const read = () => {
      const messages = messagesFromTranscriptData(data, previousSourceMessages);
      previousSourceMessages = messages;
      const next = buildSessionMessageRecordsSnapshotFromSource(
        {
          sessionID: 'ses_1',
          messages,
          parts: data.partsByMessageID,
        },
        previousSnapshot,
      );
      previousSnapshot = next;
      return next.list;
    };

    const first = read();
    const second = read();
    expect(first.length).toBe(2);
    expect(second).toBe(first);
  });
});
