import { describe, expect, it, vi } from 'vitest';

import type { ActiveRuntime } from '@/lib/connectionController';
import {
  loadSessionQueueChips,
  parseQueueScope,
  parseQueueSnapshotScopes,
  previewQueueContent,
} from '@/lib/messageQueueApi';

const activeDirect = (url = 'http://127.0.0.1:2606'): ActiveRuntime => ({
  connectionId: 'c1',
  label: 'local',
  candidates: [{ kind: 'direct', url }],
  transport: { kind: 'direct', url },
  clientToken: 'token-1',
});

describe('messageQueueApi parsers', () => {
  it('parses snapshot scopes and scope page', () => {
    const scopes = parseQueueSnapshotScopes({
      revision: 3,
      scopes: [
        {
          scopeID: 's1',
          revision: 2,
          directory: '/repo',
          sessionID: 'ses_1',
          worktreeState: 'ok',
          itemCount: 1,
        },
      ],
    });
    expect(scopes[0]?.sessionID).toBe('ses_1');

    const scope = parseQueueScope({
      scopeID: 's1',
      revision: 2,
      directory: '/repo',
      sessionID: 'ses_1',
      worktreeState: 'ok',
      itemCount: 1,
      items: [
        {
          queueItemID: 'qi1',
          operationID: 'op1',
          messageID: 'm1',
          content: 'hello\nworld',
          status: 'queued',
          attemptCount: 0,
          position: 0,
          rowVersion: 1,
          createdAt: 1,
        },
      ],
    });
    expect(scope?.items[0]?.queueItemID).toBe('qi1');
    expect(previewQueueContent(scope!.items[0]!.content)).toBe('hello');
  });
});

describe('loadSessionQueueChips', () => {
  it('loads scope items for matching session', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/message-queue/scopes/')) {
        return new Response(
          JSON.stringify({
            scopeID: 's1',
            revision: 2,
            directory: '/repo',
            sessionID: 'ses_1',
            worktreeState: 'ok',
            itemCount: 1,
            items: [
              {
                queueItemID: 'qi1',
                operationID: 'op1',
                messageID: 'm1',
                content: 'queued text',
                status: 'queued',
                attemptCount: 0,
                position: 0,
                rowVersion: 1,
                createdAt: 1,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          revision: 2,
          scopes: [
            {
              scopeID: 's1',
              revision: 2,
              directory: '/repo',
              sessionID: 'ses_1',
              worktreeState: 'ok',
              itemCount: 1,
            },
          ],
          worktreeOrders: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch);

    const scope = await loadSessionQueueChips(activeDirect(), 'ses_1');
    expect(scope?.items).toHaveLength(1);
    expect(scope?.items[0]?.content).toBe('queued text');
    expect(calls.some((u) => u.includes('/api/openchamber/message-queue'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('returns empty chips when snapshot has no matching scope', async () => {
    vi.stubGlobal(
      'fetch',
      (async () =>
        new Response(JSON.stringify({ revision: 0, scopes: [], worktreeOrders: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch,
    );
    const scope = await loadSessionQueueChips(activeDirect(), 'ses_missing');
    expect(scope?.items).toEqual([]);
    vi.unstubAllGlobals();
  });
});
