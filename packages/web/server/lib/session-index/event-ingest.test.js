import { describe, expect, it, vi } from 'vitest';

import { applySessionIndexEvent } from './event-ingest.js';

describe('session index event ingest', () => {
  it('writes session summaries, user activity, and status to the service', () => {
    const service = {
      upsertAndReportChange: vi.fn(() => true),
      touchActivity: vi.fn(() => true),
      updateStatus: vi.fn(() => true),
      remove: vi.fn(() => true),
    };

    applySessionIndexEvent(service, {
      directory: '/repo',
      payload: {
        type: 'session.created',
        properties: { info: { id: 'ses_1', title: 'Session', time: { created: 1, updated: 1 } } },
      },
    }, 100);
    applySessionIndexEvent(service, {
      directory: '/repo',
      payload: {
        type: 'message.updated',
        properties: { info: { sessionID: 'ses_1', role: 'user', time: { created: 200 } } },
      },
    }, 201);
    applySessionIndexEvent(service, {
      directory: '/repo',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'ses_1', status: { type: 'busy' } },
      },
    }, 300);

    expect(service.upsertAndReportChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ses_1', directory: '/repo' }),
      100,
      { preserveActivity: true },
    );
    expect(service.touchActivity).toHaveBeenCalledWith('ses_1', 200);
    expect(service.updateStatus).toHaveBeenCalledWith('ses_1', 'busy', 300);
  });

  it('propagates an unchanged session summary without publishing a revision', () => {
    const service = { upsertAndReportChange: vi.fn(() => false) };

    expect(applySessionIndexEvent(service, {
      directory: '/repo',
      payload: {
        type: 'session.updated',
        properties: { info: { id: 'ses_1', title: 'Session', time: { created: 1, updated: 1 } } },
      },
    }, 100)).toBe(false);
  });

  it('ignores assistant message activity', () => {
    const service = { touchActivity: vi.fn() };

    expect(applySessionIndexEvent(service, {
      type: 'message.updated',
      properties: { info: { sessionID: 'ses_1', role: 'assistant', time: { created: 200 } } },
    }, 201)).toBe(false);
    expect(service.touchActivity).not.toHaveBeenCalled();
  });

  it('promotes a session when its task completes', () => {
    const service = {
      touchActivity: vi.fn(() => true),
      updateStatus: vi.fn(() => true),
    };

    expect(applySessionIndexEvent(service, {
      type: 'session.idle',
      properties: { sessionID: 'ses_1' },
    }, 400)).toBe(true);

    expect(service.touchActivity).toHaveBeenCalledWith('ses_1', 400);
    expect(service.updateStatus).toHaveBeenCalledWith('ses_1', 'idle', 400);
  });

  it('projects Host archive onto session upserts and cleans metadata on delete', () => {
    const service = {
      upsertAndReportChange: vi.fn(() => true),
      remove: vi.fn(() => true),
    };
    const onSessionDeleted = vi.fn();
    const projectSession = (session) => ({
      ...session,
      time: { ...session.time, archived: 77 },
    });

    applySessionIndexEvent(service, {
      directory: '/repo',
      payload: {
        type: 'session.updated',
        properties: { info: { id: 'ses_1', title: 'S', time: { created: 1, updated: 1 } } },
      },
    }, 100, { projectSession, isHostReady: () => true });

    expect(service.upsertAndReportChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ses_1', time: { created: 1, updated: 1, archived: 77 } }),
      100,
      { preserveActivity: true },
    );

    applySessionIndexEvent(service, {
      payload: { type: 'session.deleted', properties: { sessionID: 'ses_1' } },
    }, 200, { onSessionDeleted });
    expect(service.remove).toHaveBeenCalledWith('ses_1');
    expect(onSessionDeleted).toHaveBeenCalledWith('ses_1');
  });

  it('supports v2 data.info and versioned type suffixes', () => {
    const service = { upsertAndReportChange: vi.fn(() => true) };
    applySessionIndexEvent(service, {
      directory: '/repo',
      payload: {
        type: 'session.updated.v2',
        data: { info: { id: 'ses_v2', title: 'V2', time: { created: 1, updated: 2 } } },
      },
    }, 50, { isHostReady: () => true });
    expect(service.upsertAndReportChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ses_v2', directory: '/repo' }),
      50,
      { preserveActivity: true },
    );
  });

  it('skips lifecycle index writes when Host is not ready (keeps prior rows)', () => {
    const service = { upsertAndReportChange: vi.fn(() => true) };
    expect(applySessionIndexEvent(service, {
      payload: {
        type: 'session.updated',
        properties: { info: { id: 'ses_1', time: { created: 1, updated: 1 } } },
      },
    }, 1, { isHostReady: () => false })).toBe(false);
    expect(service.upsertAndReportChange).not.toHaveBeenCalled();
  });

  it('skips index write when projectSession fails (not empty success)', () => {
    const service = { upsertAndReportChange: vi.fn(() => true) };
    expect(applySessionIndexEvent(service, {
      payload: {
        type: 'session.updated',
        properties: { info: { id: 'ses_1', time: { created: 1, updated: 1 } } },
      },
    }, 1, {
      isHostReady: () => true,
      projectSession: () => { throw new Error('store down'); },
    })).toBe(false);
    expect(service.upsertAndReportChange).not.toHaveBeenCalled();
  });
});
