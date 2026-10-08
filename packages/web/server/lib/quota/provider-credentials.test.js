import { afterEach, expect, it, vi } from 'vitest';
import { configureOpenCodeCredentials } from '../opencode/auth.js';
import { fetchQuota as fetchCodexQuota } from './providers/codex.js';
import { fetchQuotaForProvider, listConfiguredQuotaProviders } from './providers/index.js';

afterEach(() => { configureOpenCodeCredentials(null); vi.unstubAllGlobals(); });

it('quota requests follow the current active account, then stop sending after logout', async () => {
  let access = 'first-account';
  configureOpenCodeCredentials(() => ({ credential: { list: async () => access ? [{ id: 'selected', integrationID: 'openai', active: true, value: { type: 'oauth', access, refresh: 'refresh', expires: 123 } }] : [] } }));
  const fetchMock = vi.fn(async () => Response.json({ rate_limit: { primary_window: { used_percent: 20 } } }));
  vi.stubGlobal('fetch', fetchMock);
  await fetchCodexQuota();
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer first-account');
  access = 'second-account';
  await fetchCodexQuota();
  expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer second-account');
  access = '';
  await expect(fetchCodexQuota()).resolves.toMatchObject({ ok: false, configured: false });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('quota source failure remains an error with no upstream secret in the response', async () => {
  configureOpenCodeCredentials(() => ({ credential: { list: async () => { throw new Error('secret-from-upstream'); } } }));
  await expect(listConfiguredQuotaProviders()).rejects.toThrow('Unable to read OpenCode credentials');
  const result = await fetchQuotaForProvider('codex');
  expect(result).toMatchObject({ ok: false, error: 'Unable to read OpenCode credentials' });
  expect(JSON.stringify(result)).not.toContain('secret-from-upstream');
});
