import { describe, expect, test } from 'vitest';

import {
  flattenLynxAssistantHistoryPages,
  getNextLynxAssistantHistoryPageParam,
  loadLynxAssistantContactMessages,
  abortLynxAssistantSession,
  parseLynxAssistantHistoryPage,
  LynxAssistantHistoryParseError,
} from './contactMessages';

const part = (sessionID: string, messageID: string, id = 'p1') => ({
  id,
  sessionID,
  messageID,
  type: 'text',
  text: 'hi',
});

const entry = (sessionID: string, messageID: string) => ({
  sessionID,
  directory: '/work',
  info: {
    id: messageID,
    sessionID,
    role: 'user' as const,
    time: { created: 1 },
  },
  parts: [part(sessionID, messageID)],
});

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('parseLynxAssistantHistoryPage', () => {
  test('parses Cap complete page', () => {
    const page = parseLynxAssistantHistoryPage({
      entries: [entry('ses_1', 'msg_1')],
      nextCursor: null,
      complete: true,
    });
    expect(page.complete).toBe(true);
    expect(page.nextCursor).toBeNull();
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.info.id).toBe('msg_1');
  });

  test('rejects incomplete without cursor and complete with cursor', () => {
    expect(() => parseLynxAssistantHistoryPage({
      entries: [],
      nextCursor: null,
      complete: false,
    })).toThrow(LynxAssistantHistoryParseError);
    expect(() => parseLynxAssistantHistoryPage({
      entries: [],
      nextCursor: 'c1',
      complete: true,
    })).toThrow(LynxAssistantHistoryParseError);
  });

  test('rejects session/message scope mismatches', () => {
    expect(() => parseLynxAssistantHistoryPage({
      entries: [{
        sessionID: 'ses_1',
        directory: null,
        info: { id: 'msg_1', sessionID: 'ses_2', role: 'user', time: { created: 1 } },
        parts: [],
      }],
      nextCursor: null,
      complete: true,
    })).toThrow(LynxAssistantHistoryParseError);
  });
});

describe('list semantics helpers', () => {
  test('getNextLynxAssistantHistoryPageParam follows Cap complete contract', () => {
    expect(getNextLynxAssistantHistoryPageParam({
      entries: [],
      nextCursor: null,
      complete: true,
    })).toBeUndefined();
    expect(getNextLynxAssistantHistoryPageParam({
      entries: [],
      nextCursor: 'older',
      complete: false,
    })).toBe('older');
  });

  test('flattenLynxAssistantHistoryPages reverses Cap newest-first pages', () => {
    const flat = flattenLynxAssistantHistoryPages([
      { entries: [entry('ses_b', 'b1')] },
      { entries: [entry('ses_a', 'a1'), entry('ses_a', 'a2')] },
    ]);
    expect(flat.map((item) => item.info.id)).toEqual(['a1', 'a2', 'b1']);
  });
});

describe('loadLynxAssistantContactMessages', () => {
  test('GETs Cap messages route with keyset query', async () => {
    const result = await loadLynxAssistantContactMessages(async (path) => {
      expect(path).toBe('/api/openchamber/assistants/asst_1/messages?limit=30&before=cur');
      return jsonResponse(200, {
        entries: [entry('ses_1', 'msg_1')],
        nextCursor: null,
        complete: true,
      }) as never;
    }, 'asst_1', { before: 'cur' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.page.entries[0]?.info.id).toBe('msg_1');
    }
  });

  test('no-runtime / HTTP failure stay honest (never empty success)', async () => {
    expect(await loadLynxAssistantContactMessages(null, 'asst_1')).toEqual({
      status: 'no-runtime',
    });
    const failed = await loadLynxAssistantContactMessages(async () => (
      jsonResponse(500, { error: 'boom' }) as never
    ), 'asst_1');
    expect(failed.status).toBe('failed');
    if (failed.status === 'failed') {
      expect(failed.httpStatus).toBe(500);
    }
  });
});

describe('abortLynxAssistantSession', () => {
  test('POSTs Cap session/abort with binding fence', async () => {
    const result = await abortLynxAssistantSession(async (path, init) => {
      expect(path).toBe('/api/openchamber/assistants/asst_1/session/abort');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        sessionID: 'ses_1',
        sessionGeneration: 2,
      });
      return jsonResponse(200, {
        aborted: true,
        binding: { sessionID: 'ses_1', directory: '/work', sessionGeneration: 2 },
      }) as never;
    }, 'asst_1', { sessionID: 'ses_1', sessionGeneration: 2 });
    expect(result.status).toBe('ok');
  });

  test('send/abort failure paths stay explicit', async () => {
    expect(await abortLynxAssistantSession(null, 'a', {
      sessionID: 's',
      sessionGeneration: 1,
    })).toEqual({ status: 'no-runtime' });
    const conflict = await abortLynxAssistantSession(async () => (
      jsonResponse(409, { error: 'revision_conflict' }) as never
    ), 'a', { sessionID: 's', sessionGeneration: 1 });
    expect(conflict.status).toBe('revision-conflict');
  });
});
