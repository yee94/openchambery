import { describe, expect, test, vi } from 'vitest';

import {
  autoReplyLynxPermissionsWhenEnabled,
  fetchLynxPermissionAutoAccept,
  lynxAutoRespondsPermission,
  setLynxSessionPermissionAutoAccept,
  shouldShowLynxPermissionAutoAcceptControl,
  toggleLynxPermissionAutoAccept,
  type LynxPermissionAutoAcceptMap,
} from './permissionAutoAccept';
import type { LynxPermissionRequest } from './messageParts';

describe('lynxAutoRespondsPermission (Cap lineage)', () => {
  test('empty map → false; nearest explicit ancestor wins', () => {
    expect(lynxAutoRespondsPermission({
      autoAccept: {},
      sessions: [{ id: 's1' }],
      sessionID: 's1',
    })).toBe(false);

    const autoAccept: LynxPermissionAutoAcceptMap = { parent: true, child: false };
    expect(lynxAutoRespondsPermission({
      autoAccept,
      sessions: [{ id: 'parent' }, { id: 'child', parentID: 'parent' }],
      sessionID: 'child',
    })).toBe(false);

    expect(lynxAutoRespondsPermission({
      autoAccept: { parent: true },
      sessions: [{ id: 'parent' }, { id: 'child', parentID: 'parent' }],
      sessionID: 'child',
    })).toBe(true);
  });
});

describe('shouldShowLynxPermissionAutoAcceptControl', () => {
  test('unknown / ask keeps control; global allow hides', () => {
    expect(shouldShowLynxPermissionAutoAcceptControl([], undefined)).toBe(true);
    expect(shouldShowLynxPermissionAutoAcceptControl(
      [{ name: 'build', permission: 'allow' }],
      'build',
    )).toBe(false);
    expect(shouldShowLynxPermissionAutoAcceptControl(
      [{ name: 'build', permission: { '*': { '*': 'ask' } } }],
      'build',
    )).toBe(true);
  });
});

describe('permission-auto-accept API client', () => {
  test('GET /api/permission-auto-accept — failure ≠ fake empty success', async () => {
    const runtimeFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    await expect(fetchLynxPermissionAutoAccept(runtimeFetch)).resolves.toEqual({
      status: 'failed',
      error: 'permission-auto-accept GET failed (500)',
      httpStatus: 500,
    });
    expect(runtimeFetch).toHaveBeenCalledWith('/api/permission-auto-accept', { method: 'GET' });
  });

  test('GET ok parses sessions map; no-runtime when fetch missing', async () => {
    expect(await fetchLynxPermissionAutoAccept(null)).toEqual({ status: 'no-runtime' });
    const runtimeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sessions: { ses_a: true, ses_b: false } }),
    }));
    await expect(fetchLynxPermissionAutoAccept(runtimeFetch)).resolves.toEqual({
      status: 'ok',
      sessions: { ses_a: true, ses_b: false },
    });
  });

  test('PUT Cap path + body; invalid payload fails closed', async () => {
    const runtimeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sessions: { ses_a: true } }),
    }));
    const result = await setLynxSessionPermissionAutoAccept(runtimeFetch, {
      sessionId: 'ses_a',
      enabled: true,
      directory: '/repo',
    });
    expect(result).toEqual({ status: 'ok', sessions: { ses_a: true } });
    expect(runtimeFetch).toHaveBeenCalledWith(
      '/api/permission-auto-accept/sessions/ses_a',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: true, directory: '/repo' }),
      }),
    );

    const bad = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ nope: true }),
    }));
    await expect(setLynxSessionPermissionAutoAccept(bad, {
      sessionId: 'ses_a',
      enabled: false,
    })).resolves.toMatchObject({ status: 'failed' });
  });
});

describe('toggle + auto-reply', () => {
  test('togglePermissionAutoAccept draft vs session', async () => {
    const setDraft = vi.fn();
    const setSession = vi.fn(async () => undefined);
    const onOpen = vi.fn();
    const onFail = vi.fn();

    toggleLynxPermissionAutoAccept({
      permissionScopeSessionId: null,
      newSessionDraftOpen: false,
      draftPermissionAutoAcceptEnabled: false,
      permissionAutoAcceptEnabled: false,
      setDraftPermissionAutoAcceptEnabled: setDraft,
      setSessionAutoAccept: setSession,
      onOpenSessionFirst: onOpen,
      onToggleFailed: onFail,
    });
    expect(onOpen).toHaveBeenCalled();

    toggleLynxPermissionAutoAccept({
      permissionScopeSessionId: null,
      newSessionDraftOpen: true,
      draftPermissionAutoAcceptEnabled: false,
      permissionAutoAcceptEnabled: false,
      setDraftPermissionAutoAcceptEnabled: setDraft,
      setSessionAutoAccept: setSession,
      onOpenSessionFirst: onOpen,
      onToggleFailed: onFail,
    });
    expect(setDraft).toHaveBeenCalledWith(true);

    toggleLynxPermissionAutoAccept({
      permissionScopeSessionId: 'ses_a',
      newSessionDraftOpen: false,
      draftPermissionAutoAcceptEnabled: false,
      permissionAutoAcceptEnabled: false,
      setDraftPermissionAutoAcceptEnabled: setDraft,
      setSessionAutoAccept: setSession,
      onOpenSessionFirst: onOpen,
      onToggleFailed: onFail,
    });
    await Promise.resolve();
    expect(setSession).toHaveBeenCalledWith('ses_a', true);
  });

  test('auto-reply once when enabled; failures stay for manual reply', async () => {
    const permissions: LynxPermissionRequest[] = [
      {
        id: 'p_ok',
        sessionID: 'ses_a',
        permission: 'bash',
        patterns: [],
        metadata: {},
        always: [],
      },
      {
        id: 'p_fail',
        sessionID: 'ses_a',
        permission: 'edit',
        patterns: [],
        metadata: {},
        always: [],
      },
      {
        id: 'p_off',
        sessionID: 'ses_b',
        permission: 'write',
        patterns: [],
        metadata: {},
        always: [],
      },
    ];
    const runtimeFetch = vi.fn(async (path: string) => {
      if (path.includes('p_fail')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const result = await autoReplyLynxPermissionsWhenEnabled({
      runtimeFetch,
      permissions,
      autoAccept: { ses_a: true },
      sessions: [{ id: 'ses_a' }, { id: 'ses_b' }],
      directory: '/repo',
    });

    expect(result.acceptedIds).toEqual(['p_ok']);
    expect(result.remaining.map((p) => p.id)).toEqual(['p_fail', 'p_off']);
    expect(result.failures).toEqual([
      { id: 'p_fail', error: 'permission.reply failed (500)' },
    ]);
  });
});
