import { describe, expect, it, vi } from 'vitest';
import { generateCleanCompletion } from './bridge-client.js';
import { LLM_BRIDGE_VERSION } from './bridge-contract.js';

describe('external OpenCode inference bridge', () => {
  it('uses only isolated plugin discovery and authenticated RPC, never Session APIs or config writes', async () => {
    const ready = vi.fn(async () => ({ version: LLM_BRIDGE_VERSION }));
    const generate = vi.fn(async () => ({ text: 'summary', toolCalls: [], finishReason: 'stop' }));
    const client = { plugin: { list: vi.fn(async () => []) }, rpc: vi.fn(() => ({ ready, generate })), session: new Proxy({}, { get() { throw new Error('Session API is forbidden'); } }) };
    const signal = new AbortController().signal;
    await expect(generateCleanCompletion({ providerID: 'p', modelID: 'm', messages: [{ role: 'user', content: 'summarize' }], cacheKey: 'conversation-a', clientFactory: () => client, ensureBridgeDirectory: async () => '/isolated/bridge', signal })).resolves.toMatchObject({ text: 'summary', source: 'opencode.llm.bridge' });
    expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cacheKey: 'conversation-a' }), { location: { directory: '/isolated/bridge' }, signal });
    expect(client.plugin.list).toHaveBeenCalledWith({ location: { directory: '/isolated/bridge' } }, { signal });
  });

  it('fails closed on incompatible bridge protocol', async () => {
    const generate = vi.fn();
    await expect(generateCleanCompletion({ clientFactory: () => ({ plugin: { list: async () => [] }, rpc: () => ({ ready: async () => ({ version: -1 }), generate }) }), ensureBridgeDirectory: async () => '/isolated' })).rejects.toThrow('Incompatible');
    expect(generate).not.toHaveBeenCalled();
  });

  it('retries plugin readiness but never repeats an ambiguous generation failure', async () => {
    vi.useFakeTimers();
    try {
      const ready = vi.fn().mockRejectedValueOnce({ type: 'rpc.unavailable' }).mockResolvedValue({ version: LLM_BRIDGE_VERSION });
      const generate = vi.fn().mockRejectedValue(new Error('connection lost'));
      const result = generateCleanCompletion({ clientFactory: () => ({ plugin: { list: async () => [] }, rpc: () => ({ ready, generate }) }), ensureBridgeDirectory: async () => '/isolated' }).catch(error => error);
      await vi.advanceTimersByTimeAsync(250);
      expect(await result).toMatchObject({ message: 'connection lost' });
      expect(ready).toHaveBeenCalledTimes(2);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
