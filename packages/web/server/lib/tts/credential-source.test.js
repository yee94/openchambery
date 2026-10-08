import { afterEach, expect, it } from 'vitest';
import { configureOpenCodeCredentials } from '../opencode/auth.js';
import { TTSService } from './service.js';

afterEach(() => configureOpenCodeCredentials(null));

it('TTS clears its old client after logout and obtains a new client after account switching', async () => {
  let token = 'first';
  configureOpenCodeCredentials(() => ({ credential: { list: async () => token ? [{ id: 'selected', integrationID: 'openai', active: true, value: { type: 'key', key: token } }] : [] } }));
  const service = new TTSService();
  const first = await service._getClient();
  expect(await service.isAvailable()).toBe(true);
  token = 'second';
  expect(await service._getClient()).not.toBe(first);
  token = '';
  expect(await service.isAvailable()).toBe(false);
  expect(await service._getClient()).toBeNull();
});

it('TTS does not present credential read failure as unavailable success', async () => {
  configureOpenCodeCredentials(() => ({ credential: { list: async () => { throw new Error('private'); } } }));
  await expect(new TTSService().isAvailable()).rejects.toThrow(/^Unable to read OpenCode credentials$/);
});
