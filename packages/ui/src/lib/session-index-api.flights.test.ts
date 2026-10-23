import { afterEach, expect, test, vi } from 'vitest';
import { loadSessionIndexSnapshot, startSessionIndexBackgroundSync } from './session-index-api';
import * as runtime from './runtime-switch';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const deferredResponse = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
};
const response = (revision = 1) => new Response(JSON.stringify({
  available: true, revision, directories: [],
  sync: { active: false, completed: 0, total: 0, pendingDirectories: [], completedDirectories: [], failedDirectories: [] },
}));

test('same directory sets share POST but later calls retry after rejection', async () => {
  const pending = deferredResponse();
  const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response(2));
  vi.stubGlobal('fetch', fetch);
  const first = startSessionIndexBackgroundSync(['/b/', '/a', '/a']);
  const second = startSessionIndexBackgroundSync(['/a', '/b']);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  pending.resolve(new Response('', { status: 503 }));
  expect((await Promise.allSettled([first, second])).map((item) => item.status)).toEqual(['rejected', 'rejected']);
  expect((await startSessionIndexBackgroundSync(['/a', '/b']))?.revision).toBe(2);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each(['GET', 'POST'])('%s flights are isolated across runtime generations', async (method) => {
  const generation = vi.spyOn(runtime, 'getRuntimeGeneration').mockReturnValue(1);
  const old = deferredResponse();
  const fetch = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response(2));
  vi.stubGlobal('fetch', fetch);
  const load = () => method === 'GET' ? loadSessionIndexSnapshot() : startSessionIndexBackgroundSync(['/a']);
  const first = load();
  generation.mockReturnValue(2);
  const second = await load();
  expect(second?.revision).toBe(2);
  expect(fetch).toHaveBeenCalledTimes(2);
  old.resolve(response(1)); await first;
});

test('an independent GET cancellation cannot poison another reader', async () => {
  const controller = new AbortController();
  const fetch = vi.fn().mockImplementationOnce((_input, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  })).mockResolvedValueOnce(response(2));
  vi.stubGlobal('fetch', fetch);
  const first = loadSessionIndexSnapshot({ signal: controller.signal });
  const second = loadSessionIndexSnapshot();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  controller.abort();
  const [a, b] = await Promise.allSettled([first, second]);
  expect(a.status).toBe('rejected');
  expect(b.status).toBe('fulfilled');
  if (b.status === 'fulfilled') expect(b.value?.revision).toBe(2);
});
