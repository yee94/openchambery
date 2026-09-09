import { describe, expect, test, vi } from 'vitest';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import {
  connectLynxMcp,
  disconnectLynxMcp,
  loadLynxMcpSheet,
  lynxMcpStatusTone,
  mergeLynxMcpSheetRows,
  parseLynxMcpRuntimeStatus,
  parseLynxMcpStatusMap,
  setLynxMcpConnected,
} from './mcpSheet';

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('parseLynxMcpRuntimeStatus', () => {
  test('parses Cap OpenCode McpStatus variants', () => {
    expect(parseLynxMcpRuntimeStatus({ status: 'connected' })).toEqual({ kind: 'connected' });
    expect(parseLynxMcpRuntimeStatus({ status: 'disabled' })).toEqual({ kind: 'disabled' });
    expect(parseLynxMcpRuntimeStatus({ status: 'failed', error: 'boom' })).toEqual({
      kind: 'failed',
      error: 'boom',
    });
    expect(parseLynxMcpRuntimeStatus({ status: 'needs_auth' })).toEqual({ kind: 'needs_auth' });
    expect(parseLynxMcpRuntimeStatus({ status: 'needs_client_registration', error: 'reg' })).toEqual({
      kind: 'needs_client_registration',
      error: 'reg',
    });
    expect(parseLynxMcpRuntimeStatus(null).kind).toBe('unknown');
  });
});

describe('lynxMcpStatusTone', () => {
  test('matches Cap McpDropdown statusTone', () => {
    expect(lynxMcpStatusTone({ kind: 'connected' })).toBe('success');
    expect(lynxMcpStatusTone({ kind: 'failed' })).toBe('error');
    expect(lynxMcpStatusTone({ kind: 'needs_auth' })).toBe('warning');
    expect(lynxMcpStatusTone({ kind: 'needs_client_registration' })).toBe('warning');
    expect(lynxMcpStatusTone({ kind: 'disabled' })).toBe('default');
    expect(lynxMcpStatusTone(undefined)).toBe('default');
  });
});

describe('mergeLynxMcpSheetRows', () => {
  test('unions config names with status keys and sorts', () => {
    const rows = mergeLynxMcpSheetRows(
      [
        { id: 'zeta', title: 'Zeta', subtitle: 'remote' },
        { id: 'alpha', title: 'Alpha' },
      ],
      {
        alpha: { kind: 'connected' },
        beta: { kind: 'failed', error: 'down' },
      },
    );
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'beta', 'zeta']);
    expect(rows[0]).toMatchObject({ name: 'alpha', connected: true, status: { kind: 'connected' } });
    expect(rows[1]).toMatchObject({
      name: 'beta',
      title: 'beta',
      connected: false,
      status: { kind: 'failed', error: 'down' },
    });
    expect(rows[2].connected).toBe(false);
    expect(rows[2].status.kind).toBe('unknown');
  });
});

describe('loadLynxMcpSheet', () => {
  test('no-runtime when fetch missing', async () => {
    await expect(loadLynxMcpSheet(null)).resolves.toEqual({ status: 'no-runtime' });
  });

  test('loads Cap configs + GET /mcp status', async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path.startsWith('/api/config/mcp')) {
        return jsonResponse(200, [{ name: 'filesystem', type: 'local' }]);
      }
      if (path.startsWith('/mcp')) {
        return jsonResponse(200, {
          filesystem: { status: 'connected' },
          orphan: { status: 'disabled' },
        });
      }
      return jsonResponse(404, { error: 'missing' });
    }) as unknown as LynxRuntimeFetch;

    const result = await loadLynxMcpSheet(fetch, { directory: '/repo' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.rows.map((r) => r.name)).toEqual(['filesystem', 'orphan']);
    expect(result.rows[0].connected).toBe(true);
    expect(result.rows[1].status.kind).toBe('disabled');
    expect(fetch).toHaveBeenCalledWith(
      '/api/config/mcp?directory=%2Frepo',
      expect.anything(),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/mcp?directory=%2Frepo',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'x-opencode-directory': '/repo' }),
      }),
    );
  });

  test('status HTTP failure with configs still returns rows (unknown status)', async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path.startsWith('/api/config/mcp')) {
        return jsonResponse(200, [{ name: 'only-config' }]);
      }
      return jsonResponse(500, { error: 'status down' });
    }) as unknown as LynxRuntimeFetch;

    const result = await loadLynxMcpSheet(fetch);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status.kind).toBe('unknown');
    expect(result.rows[0].connected).toBe(false);
  });

  test('both endpoints dead → failed (never empty success)', async () => {
    const fetch = vi.fn(async () => jsonResponse(503, { error: 'down' })) as unknown as LynxRuntimeFetch;
    const result = await loadLynxMcpSheet(fetch);
    expect(result.status).toBe('failed');
  });

  test('status 0 → no-runtime', async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path.startsWith('/api/config/mcp')) {
        return jsonResponse(200, [{ name: 'a' }]);
      }
      return { ok: false, status: 0, json: async () => ({ error: 'no-runtime' }) };
    }) as unknown as LynxRuntimeFetch;
    await expect(loadLynxMcpSheet(fetch)).resolves.toEqual({ status: 'no-runtime' });
  });
});

describe('connect/disconnect Lynx MCP', () => {
  test('POST Cap /mcp/{name}/connect and /disconnect then refresh GET /mcp', async () => {
    let phase: 'idle' | 'after-connect' | 'after-disconnect' = 'idle';
    const fetch = vi.fn(async (path: string) => {
      if (path.includes('/connect')) {
        phase = 'after-connect';
        return jsonResponse(200, true); // Cap OpenCode boolean body
      }
      if (path.includes('/disconnect')) {
        phase = 'after-disconnect';
        return jsonResponse(200, true);
      }
      if (path.startsWith('/mcp')) {
        return jsonResponse(200, {
          filesystem: {
            status: phase === 'after-disconnect' ? 'disabled' : 'connected',
          },
        });
      }
      return jsonResponse(404, {});
    }) as unknown as LynxRuntimeFetch;

    const connected = await connectLynxMcp(fetch, { name: 'filesystem', directory: '/proj' });
    expect(connected).toEqual({ status: 'ok', runtime: { kind: 'connected' } });
    expect(fetch).toHaveBeenCalledWith(
      '/mcp/filesystem/connect?directory=%2Fproj',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/mcp?directory=%2Fproj',
      expect.objectContaining({ method: 'GET' }),
    );

    const disconnected = await disconnectLynxMcp(fetch, { name: 'filesystem' });
    expect(disconnected).toEqual({ status: 'ok', runtime: { kind: 'disabled' } });
    expect(fetch).toHaveBeenCalledWith(
      '/mcp/filesystem/disconnect',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('setLynxMcpConnected maps Cap Switch checked', async () => {
    const fetchFn = vi.fn(async (path: string) => {
      if (path.includes('/connect') || path.includes('/disconnect')) {
        return jsonResponse(200, true);
      }
      return jsonResponse(200, { x: { status: 'connected' } });
    });
    const fetch = fetchFn as unknown as LynxRuntimeFetch;

    await setLynxMcpConnected(fetch, { name: 'x', connected: true });
    expect(String(fetchFn.mock.calls[0][0])).toContain('/connect');
    await setLynxMcpConnected(fetch, { name: 'x', connected: false });
    expect(String(fetchFn.mock.calls[2][0])).toContain('/disconnect');
  });

  test('HTTP failure is honest — never fake-success', async () => {
    const fetch = vi.fn(async () => jsonResponse(502, { error: 'proxy' })) as unknown as LynxRuntimeFetch;
    const result = await connectLynxMcp(fetch, { name: 'x' });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.httpStatus).toBe(502);
    expect(result.error).toContain('proxy');
  });

  test('no-runtime when fetch null', async () => {
    await expect(connectLynxMcp(null, { name: 'x' })).resolves.toEqual({ status: 'no-runtime' });
  });
});

describe('parseLynxMcpStatusMap', () => {
  test('ignores non-object payloads', () => {
    expect(parseLynxMcpStatusMap([])).toEqual({});
    expect(parseLynxMcpStatusMap(null)).toEqual({});
  });
});
