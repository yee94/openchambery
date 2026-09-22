import { describe, expect, test } from 'vitest';

import { admitLynxAssistantMessage, parseLynxMessageAdmission } from './admission';

describe('assistant continuous/stateless admission', () => {
  test('parses Cap admission fixture shape', () => {
    const admission = parseLynxMessageAdmission({
      admitted: true,
      messageID: 'msg_1',
      binding: { sessionID: 'ses_1', directory: '/work', sessionGeneration: 2 },
    });
    expect(admission).toEqual({
      admitted: true,
      messageID: 'msg_1',
      binding: { sessionID: 'ses_1', directory: '/work', sessionGeneration: 2 },
    });
  });

  test('POST messages hits Cap route with top-level fence + messageID', async () => {
    const result = await admitLynxAssistantMessage(async (path, init) => {
      expect(path).toBe('/api/openchamber/assistants/asst_1/messages');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.sessionID).toBe('ses_old');
      expect(body.sessionGeneration).toBe(2);
      expect(typeof body.messageID).toBe('string');
      expect(body.parts).toEqual([{ type: 'text', text: 'hello' }]);
      expect(body.source).toBe('composer');
      expect(body.binding).toBeUndefined();
      return {
        ok: true,
        status: 200,
        json: async () => ({
          admitted: true,
          messageID: body.messageID,
          binding: { sessionID: 'ses_new', directory: '/work', sessionGeneration: 3 },
        }),
        text: async () => '',
      } as never;
    }, {
      assistantId: 'asst_1',
      text: 'hello',
      mode: 'stateless',
      sessionID: 'ses_old',
      sessionGeneration: 2,
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.admission.binding.sessionID).toBe('ses_new');
      expect(result.mode).toBe('stateless');
    }
  });

  test('no-runtime / HTTP failure do not invent admission', async () => {
    expect(await admitLynxAssistantMessage(null, { assistantId: 'a', text: 'x' })).toEqual({
      status: 'no-runtime',
    });
    const failed = await admitLynxAssistantMessage(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
      text: async () => '',
    }) as never, { assistantId: 'a', text: 'x' });
    expect(failed.status).toBe('failed');
    if (failed.status === 'failed') {
      expect(failed.httpStatus).toBe(500);
    }
  });

  test('revision conflict stays explicit', async () => {
    const conflict = await admitLynxAssistantMessage(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'revision_conflict' }),
      text: async () => '',
    }) as never, {
      assistantId: 'a',
      text: 'x',
      sessionID: 'ses',
      sessionGeneration: 1,
    });
    expect(conflict.status).toBe('revision-conflict');
  });
});
