import { describe, expect, it } from 'vitest';

import {
  extractSessionInfoFromPayload,
  normalizeSessionEventType,
  projectSessionLifecyclePayload,
  resolveSessionDirectory,
} from './session-projection.js';

describe('session projection event shapes', () => {
  it('normalizes version suffixes', () => {
    expect(normalizeSessionEventType('session.updated.v2')).toBe('session.updated');
    expect(normalizeSessionEventType('session.created')).toBe('session.created');
  });

  it('extracts info from properties.info and data.info', () => {
    expect(extractSessionInfoFromPayload({
      type: 'session.updated',
      properties: { info: { id: 'ses_a' } },
    })?.id).toBe('ses_a');
    expect(extractSessionInfoFromPayload({
      type: 'session.updated.v2',
      data: { info: { id: 'ses_b' } },
    })?.id).toBe('ses_b');
  });

  it('prefers location.directory', () => {
    expect(resolveSessionDirectory({
      location: { directory: '/loc' },
      directory: '/legacy',
    })).toBe('/loc');
  });

  it('projects GlobalEvent wrap and preserves envelope directory', () => {
    const projected = projectSessionLifecyclePayload({
      directory: '/repo',
      payload: {
        type: 'session.updated.v2',
        data: {
          info: {
            id: 'ses_1',
            time: { created: 1, updated: 2, archived: 50 },
          },
        },
      },
    }, () => ({ openchamber: { archive: { archivedAt: 99 } } }));

    expect(projected.directory).toBe('/repo');
    expect(projected.payload.type).toBe('session.updated.v2');
    expect(projected.payload.data.info.time.archived).toBe(99);
  });

  it('returns null for lifecycle when hostReady is false', () => {
    expect(projectSessionLifecyclePayload({
      type: 'session.updated',
      properties: { info: { id: 'ses_1', time: {} } },
    }, () => null, { hostReady: false })).toBeNull();
  });

  it('leaves message events alone when hostReady is false', () => {
    const msg = { type: 'message.updated', properties: { info: { role: 'user' } } };
    expect(projectSessionLifecyclePayload(msg, () => null, { hostReady: false })).toBe(msg);
  });
});
