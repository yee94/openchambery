import { describe, expect, test } from 'vitest';

import {
  parseLynxContactEventEnvelope,
  subscribeLynxContactEvents,
  LYNX_OPENCHAMBER_EVENTS_SSE_PATH,
} from './contactEvents';
import type { LynxEventStreamOpen } from '../chat/liveTail';

const start = {
  type: 'openchamber:contact-turn-start',
  properties: {
    assistantID: 'asst_1',
    turnID: 'msg_1',
    messageID: 'msg_1',
    occurredAt: 10,
  },
};

describe('parseLynxContactEventEnvelope', () => {
  test('parses Cap contact-turn-start, bubble delta, and turn end', () => {
    expect(parseLynxContactEventEnvelope(start)).toEqual({
      type: 'contact-turn-start',
      assistantID: 'asst_1',
      turnID: 'msg_1',
      messageID: 'msg_1',
      occurredAt: 10,
    });
    expect(parseLynxContactEventEnvelope({
      type: 'openchamber:contact-bubble-delta',
      properties: {
        assistantID: 'asst_1',
        turnID: 'msg_1',
        bubbleIndex: 0,
        delta: 'Hi',
        done: false,
        occurredAt: 11,
      },
    })).toMatchObject({ type: 'contact-bubble-delta', delta: 'Hi', done: false, bubbleIndex: 0 });
    expect(parseLynxContactEventEnvelope({
      type: 'openchamber:contact-turn-end',
      properties: {
        assistantID: 'asst_1',
        turnID: 'msg_1',
        status: 'error',
        error: ' upstream ',
        occurredAt: 12,
      },
    })).toEqual({
      type: 'contact-turn-end',
      assistantID: 'asst_1',
      turnID: 'msg_1',
      status: 'error',
      error: 'upstream',
      occurredAt: 12,
    });
    expect(parseLynxContactEventEnvelope({
      type: 'openchamber:contact-turn-end',
      properties: { assistantID: 'asst_1', turnID: 'msg_1', status: 'cancelled', occurredAt: 13 },
    })).toMatchObject({ type: 'contact-turn-end', status: 'cancelled' });
  });

  test('returns null for malformed contact envelopes', () => {
    expect(parseLynxContactEventEnvelope(null)).toBeNull();
    expect(parseLynxContactEventEnvelope({ type: 'openchamber:contact-turn-start', properties: null })).toBeNull();
    expect(parseLynxContactEventEnvelope({
      type: 'openchamber:contact-turn-start',
      properties: { assistantID: 'asst_1', turnID: 'msg_1', messageID: 'other', occurredAt: 1 },
    })).toBeNull();
    expect(parseLynxContactEventEnvelope({
      type: 'openchamber:contact-bubble-delta',
      properties: {
        assistantID: 'asst_1',
        turnID: 'msg_1',
        bubbleIndex: -1,
        delta: 'x',
        done: false,
        occurredAt: 1,
      },
    })).toBeNull();
    expect(parseLynxContactEventEnvelope({
      type: 'openchamber:contact-bubble-delta',
      properties: {
        assistantID: 'asst_1',
        turnID: 'msg_1',
        bubbleIndex: 1.5,
        delta: 'x',
        done: 'false',
        occurredAt: 1,
      },
    })).toBeNull();
    expect(parseLynxContactEventEnvelope({
      type: 'openchamber:contact-turn-end',
      properties: { assistantID: 'asst_1', turnID: 'msg_1', status: 'nope', occurredAt: 1 },
    })).toBeNull();
    expect(parseLynxContactEventEnvelope({
      type: 'openchamber:assistants-changed',
      properties: { revision: 1, occurredAt: 1 },
    })).toBeNull();
  });
});

describe('subscribeLynxContactEvents', () => {
  test('delivers this assistant only and ignores malformed frames', async () => {
    const seen: string[] = [];
    const controller = new AbortController();
    const chunks = (async function* () {
      yield `data: ${JSON.stringify(start)}\n\n`;
      yield `data: ${JSON.stringify({
        type: 'openchamber:contact-turn-start',
        properties: { assistantID: 'other', turnID: 'msg_2', messageID: 'msg_2', occurredAt: 2 },
      })}\n\n`;
      yield `data: ${JSON.stringify({
        type: 'openchamber:contact-turn-start',
        properties: { assistantID: 'asst_1' },
      })}\n\n`;
      controller.abort();
    })();
    const openStream: LynxEventStreamOpen = async () => ({
      ok: true,
      status: 200,
      chunks,
    });
    await subscribeLynxContactEvents({
      assistantID: 'asst_1',
      openStream,
      signal: controller.signal,
      path: LYNX_OPENCHAMBER_EVENTS_SSE_PATH,
      onEvent: (event) => {
        seen.push(event.turnID);
      },
    });
    expect(seen).toEqual(['msg_1']);
  });

  test('failed open is reported and does not invent a turn', async () => {
    const seen: string[] = [];
    const connections: string[] = [];
    const controller = new AbortController();
    const openStream: LynxEventStreamOpen = async () => ({
      ok: false,
      status: 503,
      error: 'stream unavailable',
    });
    await subscribeLynxContactEvents({
      assistantID: 'asst_1',
      openStream,
      signal: controller.signal,
      reconnectDelayMs: 0,
      onEvent: () => {
        seen.push('event');
      },
      onConnection: (state) => {
        connections.push(state);
        if (state === 'failed') controller.abort();
      },
    });
    expect(seen).toEqual([]);
    expect(connections).toContain('failed');
  });
});
