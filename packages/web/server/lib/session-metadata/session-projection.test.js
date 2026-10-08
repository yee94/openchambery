import { describe, expect, it } from 'vitest';

import {
  extractSessionInfoFromPayload,
  normalizeSessionEventType,
  projectSessionLifecyclePayload,
  resolveSessionDirectory,
  projectSessionWithHostMetadata,
  readSessionTitleAuthority,
} from './session-projection.js';

describe('session projection event shapes', () => {
  const titleMetadata = { openchamber: { titleAuthority: {
    sessionID: 'ses_owned', title: 'Chosen title', revision: 'r1', source: 'summary',
  } } };

  it('keeps the owned title in snapshots and native rename events regardless of upstream clocks', () => {
    const upstream = { id: 'ses_owned', title: 'Native title', time: { updated: 20 } };
    expect(projectSessionWithHostMetadata(upstream, titleMetadata).title).toBe('Chosen title');
    for (const created of [1, 20, 10000]) {
      const event = { type: 'session.renamed', created, data: { sessionID: 'ses_owned', title: 'Native title' } };
      expect(projectSessionLifecyclePayload(event, () => titleMetadata)).toEqual({
        ...event, data: { ...event.data, title: 'Chosen title' },
      });
      expect(event.data.title).toBe('Native title');
    }
    expect(projectSessionWithHostMetadata({ ...upstream, id: 'ses_fork' }, titleMetadata).title).toBe('Native title');
  });

  it('suppresses native rename while metadata is unknown, including wrapped replay', () => {
    const payload = { directory: '/repo', payload: {
      type: 'session.renamed', data: { sessionID: 'ses_owned', title: 'Native' },
    } };
    expect(projectSessionLifecyclePayload(payload, () => null, { hostReady: false })).toBeNull();
    expect(projectSessionLifecyclePayload(payload, () => titleMetadata).payload.data.title).toBe('Chosen title');
  });

  it('ignores malformed or absent authority and rename identities', () => {
    for (const metadata of [undefined, {}, { openchamber: { titleAuthority: {} } }]) {
      expect(readSessionTitleAuthority(undefined, metadata)).toBeNull();
      expect(readSessionTitleAuthority('ses_owned', metadata)).toBeNull();
    }
    const event = { type: 'session.renamed', data: {} };
    expect(projectSessionLifecyclePayload(event, () => titleMetadata)).toBe(event);
  });
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
