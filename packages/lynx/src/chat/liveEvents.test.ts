import { describe, expect, test } from 'vitest';

import {
  createLynxSseParseState,
  normalizeLynxOpenCodeEvent,
  parseLynxSseDataLine,
  projectLynxLiveEvent,
  pushLynxSseText,
  readLynxSessionStatus,
} from './liveEvents';

describe('Lynx Cap event parsing', () => {
  test('normalizes legacy session.status properties', () => {
    const result = normalizeLynxOpenCodeEvent({
      type: 'session.status',
      properties: { sessionID: 'ses_a', status: { type: 'busy' } },
    });
    expect(result).toEqual({
      action: 'emit',
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_a', status: { type: 'busy' } },
        locationDirectory: undefined,
      },
    });
    if (result.action !== 'emit') return;
    expect(readLynxSessionStatus(result.event)).toEqual({
      sessionID: 'ses_a',
      status: 'busy',
    });
  });

  test('normalizes current data/location session.status and strips version suffix', () => {
    const result = normalizeLynxOpenCodeEvent({
      type: 'session.status.1',
      data: { sessionID: 'ses_b', status: { type: 'idle' } },
      location: { path: '/repo' },
    });
    expect(result.action).toBe('emit');
    if (result.action !== 'emit') return;
    expect(result.event.type).toBe('session.status');
    expect(result.event.locationDirectory).toBe('/repo');
    expect(readLynxSessionStatus(result.event)?.status).toBe('idle');
  });

  test('unwraps global { directory, payload } envelopes', () => {
    const result = normalizeLynxOpenCodeEvent({
      directory: '/work',
      payload: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses_1',
          messageID: 'msg_1',
          partID: 'p_1',
          field: 'text',
          delta: 'hi',
        },
      },
    });
    expect(result.action).toBe('emit');
    if (result.action !== 'emit') return;
    expect(result.event.type).toBe('message.part.delta');
    expect(result.event.locationDirectory).toBe('/work');
  });

  test('drops durable sync replicas', () => {
    expect(normalizeLynxOpenCodeEvent({
      type: 'message.updated',
      properties: { info: { id: 'm1', sessionID: 's1' } },
      durable: { kind: 'sync' },
    })).toEqual({ action: 'drop', reason: 'sync-duplicate' });
  });

  test('projects message.part.delta only for the active session', () => {
    const normalized = normalizeLynxOpenCodeEvent({
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_live',
        messageID: 'msg_1',
        partID: 'part_1',
        field: 'text',
        delta: 'hello',
      },
    });
    expect(normalized.action).toBe('emit');
    if (normalized.action !== 'emit') return;
    expect(projectLynxLiveEvent(normalized.event, 'ses_live')).toEqual({
      kind: 'part-delta',
      sessionID: 'ses_live',
      messageId: 'msg_1',
      partID: 'part_1',
      field: 'text',
      delta: 'hello',
    });
    expect(projectLynxLiveEvent(normalized.event, 'ses_other')).toBeNull();
  });

  test('projects session.idle as becameIdle working=false', () => {
    const normalized = normalizeLynxOpenCodeEvent({
      type: 'session.idle',
      properties: { sessionID: 'ses_1' },
    });
    expect(normalized.action).toBe('emit');
    if (normalized.action !== 'emit') return;
    expect(projectLynxLiveEvent(normalized.event, 'ses_1')).toEqual({
      kind: 'session-working',
      sessionID: 'ses_1',
      working: false,
      becameIdle: true,
    });
  });

  test('exposes admission/activity hints for session.next.prompt.admitted', () => {
    const result = normalizeLynxOpenCodeEvent({
      type: 'session.next.prompt.admitted',
      properties: { sessionID: 'ses_1', messageID: 'msg_new' },
    });
    expect(result.action).toBe('emit');
    if (result.action !== 'emit') return;
    expect(result.event.admissionHint).toEqual({ sessionID: 'ses_1', messageID: 'msg_new' });
    expect(projectLynxLiveEvent(result.event, 'ses_1')).toEqual({
      kind: 'activity',
      sessionID: 'ses_1',
      terminal: false,
    });
  });

  test('parses SSE data lines and incremental buffers', () => {
    expect(parseLynxSseDataLine('{"type":"session.idle","properties":{"sessionID":"s"}}')).toEqual({
      type: 'session.idle',
      properties: { sessionID: 's' },
    });
    expect(parseLynxSseDataLine('[DONE]')).toBeNull();
    expect(parseLynxSseDataLine('not-json')).toBeNull();

    const state = createLynxSseParseState();
    const commits = pushLynxSseText(
      state,
      'id: evt-1\ndata: {"type":"session.status","properties":{"sessionID":"ses","status":{"type":"busy"}}}\n\n',
    );
    expect(commits).toHaveLength(1);
    expect(commits[0]?.id).toBe('evt-1');
    expect(commits[0]?.raw).toMatchObject({ type: 'session.status' });
    expect(state.lastEventId).toBe('evt-1');
  });

  test('joins multi-line SSE data payloads', () => {
    const state = createLynxSseParseState();
    const commits = pushLynxSseText(
      state,
      'data: {"type":"message.part.delta","properties":{\n'
      + 'data: "sessionID":"ses","messageID":"m","partID":"p","field":"text","delta":"x"}}\n\n',
    );
    expect(commits).toHaveLength(1);
    const normalized = normalizeLynxOpenCodeEvent(commits[0]?.raw);
    expect(normalized.action).toBe('emit');
  });
});
