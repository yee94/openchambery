import { describe, expect, it, vi } from 'vitest';

import type { ActiveRuntime } from '@/lib/connectionController';
import { pinSession, SessionIndexPinError, togglePinnedSession, unpinSession } from '@/lib/sessionIndexPin';

vi.mock('@/lib/openchamberClient', () => ({
  openchamberFetch: vi.fn(),
}));

import { openchamberFetch } from '@/lib/openchamberClient';

const active = {
  clientToken: 'tok',
  transport: { kind: 'direct', url: 'http://127.0.0.1:4096' },
} as ActiveRuntime;

describe('sessionIndexPin', () => {
  it('POSTs pin and DELETEs unpin', async () => {
    vi.mocked(openchamberFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => null,
      text: async () => '',
    });
    await pinSession(active, 'ses_1');
    expect(openchamberFetch).toHaveBeenCalledWith(
      active,
      '/api/openchamber/session-index/session/ses_1/pin',
      expect.objectContaining({ method: 'POST' }),
    );
    await unpinSession(active, 'ses_1');
    expect(openchamberFetch).toHaveBeenCalledWith(
      active,
      '/api/openchamber/session-index/session/ses_1/pin',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('togglePinnedSession flips based on current state', async () => {
    vi.mocked(openchamberFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => null,
      text: async () => '',
    });
    await expect(togglePinnedSession(active, 'ses_2', false)).resolves.toBe(true);
    await expect(togglePinnedSession(active, 'ses_2', true)).resolves.toBe(false);
  });

  it('maps 501 to SessionIndexPinError', async () => {
    vi.mocked(openchamberFetch).mockResolvedValue({
      ok: false,
      status: 501,
      json: async () => null,
      text: async () => '',
    });
    await expect(pinSession(active, 'ses_x')).rejects.toBeInstanceOf(SessionIndexPinError);
  });
});
