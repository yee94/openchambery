import { describe, expect, test } from 'bun:test';
import {
  checkIsGitRepository,
  discoverGitRepositories,
  getGitStatus,
  getGitBranches,
  getRemotes,
  gitFetch,
  listGitWorktrees,
  resolveGitPrimaryRoot,
  stageGitFile,
  stageGitFiles,
  unstageGitFile,
  unstageGitFiles,
} from './gitApiHttp';

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const previousFetch = globalThis.fetch;
const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

const installFetchMock = () => {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
};

const installWindowMock = () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: 'http://localhost:3000' },
    },
  });
};

const restoreMocks = () => {
  globalThis.fetch = previousFetch;
  if (previousWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
  } else {
    delete (globalThis as { window?: Window }).window;
  }
};

const captureError = async (callback: () => Promise<void>): Promise<unknown> => {
  try {
    await callback();
    return null;
  } catch (error) {
    return error;
  }
};

describe('gitApiHttp index mutations', () => {
  test('sends bulk stage payloads as paths', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      await stageGitFiles('/repo', ['a.ts', 'b.ts']);

      expect(calls).toHaveLength(1);
      expect(String(calls[0].input)).toBe('/api/git/stage?directory=%2Frepo');
      expect(calls[0].init?.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ paths: ['a.ts', 'b.ts'] });
    } finally {
      restoreMocks();
    }
  });

  test('sends bulk unstage payloads as paths', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      await unstageGitFiles('/repo', ['a.ts', 'b.ts']);

      expect(calls).toHaveLength(1);
      expect(String(calls[0].input)).toBe('/api/git/unstage?directory=%2Frepo');
      expect(calls[0].init?.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ paths: ['a.ts', 'b.ts'] });
    } finally {
      restoreMocks();
    }
  });

  test('single-file helpers use the bulk paths payload shape', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      await stageGitFile('/repo', 'a.ts');
      await unstageGitFile('/repo', 'b.ts');

      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ paths: ['a.ts'] });
      expect(JSON.parse(String(calls[1].init?.body))).toEqual({ paths: ['b.ts'] });
    } finally {
      restoreMocks();
    }
  });

  test('rejects empty bulk path lists before fetching', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      const stageError = await captureError(() => stageGitFiles('/repo', [' ', '']));
      const unstageError = await captureError(() => unstageGitFiles('/repo', []));

      expect(stageError).toBeInstanceOf(Error);
      expect((stageError as Error).message).toBe('path is required to stage git changes');
      expect(unstageError).toBeInstanceOf(Error);
      expect((unstageError as Error).message).toBe('path is required to unstage git changes');
      expect(calls).toHaveLength(0);
    } finally {
      restoreMocks();
    }
  });
});

describe('gitApiHttp branch discovery', () => {
  test('passes AbortSignal through branches and remotes runtime requests', async () => {
    installWindowMock();
    const calls = installFetchMock();
    const controller = new AbortController();
    try {
      await getGitBranches('/repo', { signal: controller.signal });
      await getRemotes('/repo', { signal: controller.signal });

      expect(calls).toHaveLength(2);
      expect(calls[0].init?.signal).toBe(controller.signal);
      expect(calls[1].init?.signal).toBe(controller.signal);
    } finally {
      restoreMocks();
    }
  });
});

describe('gitApiHttp discovery fan-out', () => {
  test('caps concurrent primary-root / worktrees network calls at 2', async () => {
    installWindowMock();
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (!url.includes('/api/git/primary-root') && !url.includes('/api/git/worktrees')) {
        return new Response('{}', { status: 200 });
      }
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve();
        });
      });
      if (url.includes('/worktrees')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ root: '/repo' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const pending = Promise.all([
        resolveGitPrimaryRoot('/a'),
        resolveGitPrimaryRoot('/b'),
        listGitWorktrees('/c'),
        listGitWorktrees('/d'),
      ]);

      // Let the first two discovery slots start.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(peak).toBeLessThanOrEqual(2);
      expect(releases.length).toBe(2);

      while (releases.length > 0) {
        releases.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await pending;
      expect(peak).toBeLessThanOrEqual(2);
    } finally {
      restoreMocks();
    }
  });

  test('dedupes in-flight primary-root for the same directory', async () => {
    installWindowMock();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ root: '/same' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const [a, b] = await Promise.all([
        resolveGitPrimaryRoot('/same-root'),
        resolveGitPrimaryRoot('/same-root'),
      ]);
      expect(a.root).toBe('/same');
      expect(b.root).toBe('/same');
      expect(calls).toBe(1);
    } finally {
      restoreMocks();
    }
  });

  test('batch discover writes caches so subsequent single lookups skip network', async () => {
    installWindowMock();
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/git/discover')) {
        return new Response(JSON.stringify([
          { directory: '/batch-a', isGitRepository: true, primaryRoot: '/batch-a' },
          { directory: '/batch-b', isGitRepository: false, primaryRoot: null },
        ]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected single lookup' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const discovered = await discoverGitRepositories(['/batch-a', '/batch-b', '/batch-a']);
      expect(discovered.get('/batch-a')).toEqual({
        isGitRepository: true,
        primaryRoot: '/batch-a',
      });
      expect(discovered.get('/batch-b')).toEqual({
        isGitRepository: false,
        primaryRoot: null,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('/api/git/discover');
      expect(calls[0]).toContain('directories=%2Fbatch-a');
      expect(calls[0]).toContain('directories=%2Fbatch-b');

      const isRepoA = await checkIsGitRepository('/batch-a');
      const isRepoB = await checkIsGitRepository('/batch-b');
      const rootA = await resolveGitPrimaryRoot('/batch-a');
      expect(isRepoA).toBe(true);
      expect(isRepoB).toBe(false);
      expect(rootA.root).toBe('/batch-a');
      // Cache hits only — no extra check / primary-root network calls.
      expect(calls).toHaveLength(1);
    } finally {
      restoreMocks();
    }
  });

  test('batch discover falls back to single requests when endpoint is unavailable', async () => {
    installWindowMock();
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/git/discover')) {
        return new Response(JSON.stringify({ error: 'not implemented' }), {
          status: 501,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/git/check')) {
        return new Response(JSON.stringify({ isGitRepository: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/git/primary-root')) {
        return new Response(JSON.stringify({ root: '/fallback-root' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    try {
      const discovered = await discoverGitRepositories(['/fallback-dir']);
      expect(discovered.get('/fallback-dir')).toEqual({
        isGitRepository: true,
        primaryRoot: '/fallback-root',
      });
      expect(calls.some((url) => url.includes('/api/git/discover'))).toBe(true);
      expect(calls.some((url) => url.includes('/api/git/check'))).toBe(true);
      expect(calls.some((url) => url.includes('/api/git/primary-root'))).toBe(true);

      // Fallback also seeds caches.
      const cached = await checkIsGitRepository('/fallback-dir');
      expect(cached).toBe(true);
      const checkCallsAfter = calls.filter((url) => url.includes('/api/git/check')).length;
      expect(checkCallsAfter).toBe(1);
    } finally {
      restoreMocks();
    }
  });
});

describe('gitApiHttp status cache', () => {
  test('invalidates cached status after fetch', async () => {
    installWindowMock();
    const calls: FetchCall[] = [];
    let statusRequestCount = 0;
    globalThis.fetch = (async (input, init) => {
      calls.push({ input, init });
      const url = String(input);
      if (url.startsWith('/api/git/status')) {
        statusRequestCount += 1;
        return new Response(JSON.stringify({
          current: 'main',
          tracking: 'origin/main',
          ahead: 0,
          behind: statusRequestCount === 1 ? 0 : 2,
          files: [],
          isClean: true,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const directory = '/repo-cache-fetch';
      const first = await getGitStatus(directory);
      const cached = await getGitStatus(directory);
      await gitFetch(directory, { remote: 'origin' });
      const afterFetch = await getGitStatus(directory);

      expect(first.behind).toBe(0);
      expect(cached.behind).toBe(0);
      expect(afterFetch.behind).toBe(2);
      expect(statusRequestCount).toBe(2);
      expect(calls.map((call) => String(call.input))).toEqual([
        '/api/git/status?directory=%2Frepo-cache-fetch',
        '/api/git/fetch?directory=%2Frepo-cache-fetch',
        '/api/git/status?directory=%2Frepo-cache-fetch',
      ]);
    } finally {
      restoreMocks();
    }
  });
});
