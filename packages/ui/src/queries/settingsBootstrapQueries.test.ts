import { beforeEach, describe, expect, mock, test } from 'bun:test';

let runtimeKey = 'runtime-a';
let calls = 0;
let seenPath = '';
let seenSignal: AbortSignal | undefined;
let payload: unknown;
let responseStatus = 200;
let resolveRequest: (() => void) | undefined;

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => runtimeKey,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string, options?: RequestInit) => {
    calls += 1;
    seenPath = path;
    seenSignal = options?.signal ?? undefined;
    if (resolveRequest) await new Promise<void>((resolve) => { resolveRequest = resolve; });
    return new Response(JSON.stringify(payload), { status: responseStatus });
  },
}));

const { queryClient } = await import('@/lib/queryRuntime');
const { parseSettingsBootstrap } = await import('./settingsBootstrapParser');
const {
  ensureSettingsBootstrapQuery,
  patchSettingsBootstrapSnapshot,
  readSettingsBootstrapSnapshot,
  settingsBootstrapQueryOptions,
} = await import('./settingsBootstrapQueries');

describe('settingsBootstrapQueries', () => {
  beforeEach(() => {
    queryClient.clear();
    runtimeKey = 'runtime-a';
    calls = 0;
    seenPath = '';
    seenSignal = undefined;
    payload = { schemaVersion: 1, defaultModel: 'provider/model', autoCreateWorktree: true };
    responseStatus = 200;
    resolveRequest = undefined;
  });

  test('解析显式 schema 的精简响应，并丢弃 credential sentinel 与未知字段', () => {
    const sentinel = 'credential-sentinel';
    expect(parseSettingsBootstrap({ schemaVersion: 1, defaultModel: ' model ', apiKey: sentinel, unknown: sentinel })).toEqual({ schemaVersion: 1, defaultModel: 'model' });
    expect(() => parseSettingsBootstrap({ defaultAgent: 'build', sttProvider: 'openai-compatible', responseStyleEnabled: true, token: sentinel })).toThrow('Unsupported settings bootstrap schema version');
  });

  test('schema、枚举、URL 与长度边界经过字段校验', () => {
    expect(() => parseSettingsBootstrap({ schemaVersion: 2 })).toThrow('Unsupported settings bootstrap schema version');
    expect(() => parseSettingsBootstrap({ defaultModel: 'provider/model' })).toThrow('Unsupported settings bootstrap schema version');
    const maxUrl = `https://stt.example/${'p'.repeat(4_076)}`;
    expect(parseSettingsBootstrap({ schemaVersion: 1, defaultModel: 'x'.repeat(512), sttLanguage: 'z'.repeat(64), responseStyleCustomInstructions: 'i'.repeat(200_000), sttServerUrl: maxUrl })).toEqual({ schemaVersion: 1, defaultModel: 'x'.repeat(512), sttLanguage: 'z'.repeat(64), responseStyleCustomInstructions: 'i'.repeat(200_000), sttServerUrl: maxUrl });
    expect(parseSettingsBootstrap({ schemaVersion: 1, defaultModel: 'x'.repeat(513), sttLanguage: 'z'.repeat(65), responseStyleCustomInstructions: 'i'.repeat(200_001), sttServerUrl: `${maxUrl}x`, messageStreamTransport: 'poll' })).toEqual({ schemaVersion: 1 });
    expect(parseSettingsBootstrap({ schemaVersion: 1, sttServerUrl: 'https://user:secret@stt.example' })).toEqual({ schemaVersion: 1 });
  });

  test('请求安全 bootstrap 路径和 AbortSignal，并由同 key 并发读取合并', async () => {
    const first = ensureSettingsBootstrapQuery(runtimeKey);
    const second = ensureSettingsBootstrapQuery(runtimeKey);
    expect(calls).toBe(1);
    expect(seenPath).toBe('/api/config/settings/bootstrap');
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(await Promise.all([first, second])).toEqual([
      { schemaVersion: 1, defaultModel: 'provider/model', autoCreateWorktree: true },
      { schemaVersion: 1, defaultModel: 'provider/model', autoCreateWorktree: true },
    ]);
  });

  test('无限 freshness 复用缓存，transport key 相互隔离', async () => {
    await ensureSettingsBootstrapQuery(runtimeKey);
    await ensureSettingsBootstrapQuery(runtimeKey);
    runtimeKey = 'runtime-b';
    payload = { schemaVersion: 1, defaultAgent: 'agent-b' };
    await ensureSettingsBootstrapQuery(runtimeKey);
    expect(calls).toBe(2);
    expect(readSettingsBootstrapSnapshot('runtime-a')).toEqual({ schemaVersion: 1, defaultModel: 'provider/model', autoCreateWorktree: true });
    expect(readSettingsBootstrapSnapshot('runtime-b')).toEqual({ schemaVersion: 1, defaultAgent: 'agent-b' });
    expect(settingsBootstrapQueryOptions('runtime-a').queryKey).toEqual(['runtime-a', 'settings', 'bootstrap']);
  });

  test('瞬态失败重试一次并保留旧 cache', async () => {
    await ensureSettingsBootstrapQuery(runtimeKey);
    responseStatus = 503;
    await queryClient.invalidateQueries({ queryKey: settingsBootstrapQueryOptions(runtimeKey).queryKey, exact: true });
    await expect(ensureSettingsBootstrapQuery(runtimeKey)).rejects.toThrow('Settings bootstrap request failed (503)');
    expect(calls).toBe(3);
    expect(readSettingsBootstrapSnapshot(runtimeKey)).toEqual({ schemaVersion: 1, defaultModel: 'provider/model', autoCreateWorktree: true });
  });

  for (const status of [404, 501]) {
    test(`安全能力缺失状态 ${status} 停止重试`, async () => {
      responseStatus = status;
      await expect(ensureSettingsBootstrapQuery(runtimeKey)).rejects.toThrow(`Settings bootstrap request failed (${status})`);
      expect(calls).toBe(1);
    });
  }

  test('patch 校验字段并更新指定 transport cache', async () => {
    await ensureSettingsBootstrapQuery(runtimeKey);
    runtimeKey = 'runtime-b';
    await ensureSettingsBootstrapQuery(runtimeKey);
    expect(patchSettingsBootstrapSnapshot({ sttProvider: 'local', responseStyleCustomInstructions: 'Use concise replies.' }, 'runtime-a')).toEqual({ schemaVersion: 1, defaultModel: 'provider/model', autoCreateWorktree: true, sttProvider: 'local', responseStyleCustomInstructions: 'Use concise replies.' });
    expect(readSettingsBootstrapSnapshot('runtime-a')).toEqual({ schemaVersion: 1, defaultModel: 'provider/model', autoCreateWorktree: true, sttProvider: 'local', responseStyleCustomInstructions: 'Use concise replies.' });
    expect(readSettingsBootstrapSnapshot('runtime-b')).toEqual({ schemaVersion: 1, defaultModel: 'provider/model', autoCreateWorktree: true });
    expect(() => patchSettingsBootstrapSnapshot({ sttProvider: 'server' } as never)).toThrow('Invalid settings bootstrap patch');
    expect(() => patchSettingsBootstrapSnapshot({ apiKey: 'credential-sentinel' } as never)).toThrow('Invalid settings bootstrap patch');
  });

  test('response style preset 只接受固定枚举', () => {
    const presets = ['concise', 'detailed', 'mentor', 'pushback', 'noFiller', 'matchEnergy', 'warmPeer', 'custom'];
    for (const responseStylePreset of presets) {
      expect(parseSettingsBootstrap({ schemaVersion: 1, responseStylePreset })).toEqual({ schemaVersion: 1, responseStylePreset });
    }
    expect(parseSettingsBootstrap({ schemaVersion: 1, responseStylePreset: 'verbose' })).toEqual({ schemaVersion: 1 });
  });
});
