import { beforeEach, describe, expect, mock, test } from 'bun:test';

let responses: Response[] = [];
const calls: Array<{ path: string; options?: { method?: string } }> = [];
const runtimeFetch = async (path: string, options?: { method?: string }) => {
  calls.push({ path, options });
  const next = responses.shift();
  if (!next) {
    return new Response(null, { status: 500 });
  }
  return next;
};

mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch }));

const { checkOpenCodeAvailability, retryOpenCodeAvailability } = await import('./openCodeAvailability');

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('OpenCode onboarding availability', () => {
  beforeEach(() => {
    calls.length = 0;
    responses = [];
  });

  test('reads readiness from the OpenChamber health snapshot', async () => {
    responses = [jsonResponse({ isOpenCodeReady: true })];

    expect(await checkOpenCodeAvailability()).toBe(true);
    expect(calls).toEqual([{ path: '/health', options: undefined }]);
  });

  test('keeps waiting when the health snapshot is not ready', async () => {
    responses = [jsonResponse({ openCodeRunning: false, isOpenCodeReady: false })];

    expect(await checkOpenCodeAvailability()).toBe(false);
  });

  test('requests a managed OpenCode startup retry and re-checks health', async () => {
    responses = [
      jsonResponse({ success: true }),
      jsonResponse({ isOpenCodeReady: true }),
    ];

    expect(await retryOpenCodeAvailability()).toBe(true);
    expect(calls).toEqual([
      { path: '/api/opencode/retry', options: { method: 'POST' } },
      { path: '/health', options: undefined },
    ]);
  });

  test('treats retry HTTP success without ready health as unavailable', async () => {
    responses = [
      jsonResponse({ success: true }),
      jsonResponse({ openCodeRunning: false, isOpenCodeReady: false }),
    ];

    expect(await retryOpenCodeAvailability()).toBe(false);
    expect(calls.map((entry) => entry.path)).toEqual(['/api/opencode/retry', '/health']);
  });

  test('fails closed when retry itself is not ok', async () => {
    responses = [jsonResponse({ success: false }, 503)];

    expect(await retryOpenCodeAvailability()).toBe(false);
    expect(calls).toEqual([{ path: '/api/opencode/retry', options: { method: 'POST' } }]);
  });
});
