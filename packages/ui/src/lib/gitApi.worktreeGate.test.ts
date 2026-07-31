import { afterEach, describe, expect, test } from 'bun:test';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { RuntimeAPIs } from '@/lib/api/types';
import * as gitApiHttp from './gitApiHttp';
import { listGitWorktrees } from './gitApi';

const previousFetch = globalThis.fetch;
const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

const installWindowMock = () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://localhost:3000' } },
  });
};

// Mirrors packages/web/src/api/git.ts: the browser bridge hands back the very
// gitApiHttp helper that already takes a discovery slot.
const installWebStyleBridge = () => {
  registerRuntimeAPIs({
    git: { listGitWorktrees: gitApiHttp.listGitWorktrees },
  } as unknown as RuntimeAPIs);
};

afterEach(() => {
  registerRuntimeAPIs(null);
  globalThis.fetch = previousFetch;
  if (previousWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
  } else {
    delete (globalThis as { window?: Window }).window;
  }
});

describe('listGitWorktrees discovery gate', () => {
  test('concurrent listings through a gated bridge still settle', async () => {
    installWindowMock();
    installWebStyleBridge();

    globalThis.fetch = (async (input) => {
      const url = String(input);
      // Yield so both listings are in flight before either resolves; that
      // overlap is what used to exhaust the gate's permits.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify([{ path: url.includes('%2Fa') ? '/a' : '/b' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const settled = await Promise.race([
      Promise.all([listGitWorktrees('/a'), listGitWorktrees('/b')]),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);

    expect(settled).not.toBe('timeout');
    expect(Array.isArray(settled)).toBe(true);
    expect((settled as unknown[]).length).toBe(2);
  });

  test('a later listing still runs after concurrent listings complete', async () => {
    installWindowMock();
    installWebStyleBridge();

    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await Promise.all([listGitWorktrees('/one'), listGitWorktrees('/two')]);

    const followUp = await Promise.race([
      listGitWorktrees('/three'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);

    expect(followUp).not.toBe('timeout');
    expect(requests).toBe(3);
  });
});
