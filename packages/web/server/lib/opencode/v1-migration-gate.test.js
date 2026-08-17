import { describe, expect, it, vi } from 'vitest';

import {
  OPENCODE_V1_MIGRATION_PATH,
  V1_MIGRATION_USER_NOTICE,
  evaluateV1MigrationGate,
  fetchV1MigrationGate,
} from './v1-migration-gate.js';

describe('V1 migration gate', () => {
  it('denies transcript while V1 migration is required', () => {
    expect(evaluateV1MigrationGate({ status: 'required' })).toMatchObject({
      admitTranscript: false,
      phase: 'required',
      userNotice: V1_MIGRATION_USER_NOTICE,
    });
  });

  it('denies transcript while V1 migration is running and keeps progress', () => {
    expect(evaluateV1MigrationGate({
      status: 'running',
      progress: { label: 'Sessions', numerator: 3, denominator: 10 },
    })).toEqual({
      admitTranscript: false,
      phase: 'running',
      progress: { label: 'Sessions', numerator: 3, denominator: 10 },
      userNotice: V1_MIGRATION_USER_NOTICE,
    });
  });

  it('admits transcript when V1 migration is completed', () => {
    expect(evaluateV1MigrationGate({ status: 'completed' })).toMatchObject({
      admitTranscript: true,
      phase: 'completed',
    });
  });

  it('admits transcript when V1 library is absent (HTTP 404)', () => {
    expect(evaluateV1MigrationGate({ httpStatus: 404 })).toEqual({
      admitTranscript: true,
      phase: 'absent',
    });
    expect(evaluateV1MigrationGate({ status: 404 })).toEqual({
      admitTranscript: true,
      phase: 'absent',
    });
  });

  it('admits transcript when completed with no remaining work', () => {
    expect(evaluateV1MigrationGate({
      body: { status: 'completed' },
      httpStatus: 200,
    })).toMatchObject({
      admitTranscript: true,
      phase: 'completed',
    });
  });

  it('denies transcript on V1 migration error instead of treating an empty list as success', () => {
    expect(evaluateV1MigrationGate({
      status: 'error',
      error: 'disk full',
    })).toEqual({
      admitTranscript: false,
      phase: 'error',
      error: 'disk full',
      userNotice: V1_MIGRATION_USER_NOTICE,
    });
    expect(evaluateV1MigrationGate({})).toMatchObject({
      admitTranscript: false,
      phase: 'error',
    });
  });

  it('denies transcript on network failure instead of treating an empty list as success', () => {
    expect(evaluateV1MigrationGate({ error: new Error('offline') })).toMatchObject({
      admitTranscript: false,
      phase: 'error',
      error: 'offline',
    });
  });

  it('exposes backfill userNotice for UI and docs', () => {
    expect(V1_MIGRATION_USER_NOTICE).toContain('Message ids are reused');
    expect(V1_MIGRATION_USER_NOTICE).toContain('interrupted');
    expect(V1_MIGRATION_USER_NOTICE).toContain('V1 subtasks do not appear in v2');
    expect(evaluateV1MigrationGate({ status: 'required' }).userNotice).toBe(V1_MIGRATION_USER_NOTICE);
    expect(evaluateV1MigrationGate({ status: 'completed' }).userNotice).toBe(V1_MIGRATION_USER_NOTICE);
  });

  it('polls GET migration status and does not POST', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'completed' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(fetchV1MigrationGate({
      url: `http://127.0.0.1:4096${OPENCODE_V1_MIGRATION_PATH}`,
      headers: { Authorization: 'Basic test' },
      fetchImpl,
    })).resolves.toMatchObject({
      admitTranscript: true,
      phase: 'completed',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain(OPENCODE_V1_MIGRATION_PATH);
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Basic test');
  });
});
