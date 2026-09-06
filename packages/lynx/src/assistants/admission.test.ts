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

  test('POST messages hits Cap route', async () => {
    const result = await admitLynxAssistantMessage(async (path, init) => {
      expect(path).toBe('/api/openchamber/assistants/asst_1/messages');
      expect(init?.method).toBe('POST');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          admitted: true,
          messageID: 'msg_1',
          binding: { sessionID: 'ses_new', directory: '/work', sessionGeneration: 3 },
        }),
        text: async () => '',
      } as never;
    }, {
      assistantId: 'asst_1',
      text: 'hello',
      mode: 'stateless',
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.admission.binding.sessionID).toBe('ses_new');
      expect(result.mode).toBe('stateless');
    }
  });

  test('no-runtime does not invent admission', async () => {
    expect(await admitLynxAssistantMessage(null, { assistantId: 'a', text: 'x' })).toEqual({
      status: 'no-runtime',
    });
  });
});
