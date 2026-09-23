import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import { installPinnedOpenCode2Cli, readOpenCode2BinaryVersion } from './ensure-cli.js';

vi.mock('./ensure-cli.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    installPinnedOpenCode2Cli: vi.fn(actual.installPinnedOpenCode2Cli),
    readOpenCode2BinaryVersion: vi.fn(actual.readOpenCode2BinaryVersion),
  };
});

import { registerOpenCodeRoutes } from './routes.js';
import { isOpenCode1xVersion } from './opencode2-pin.js';

const createDependencies = ({ formatSettingsResponse }) => ({
  crypto: {},
  clientReloadDelayMs: 0,
  getOpenCodeResolutionSnapshot: vi.fn(),
  formatSettingsResponse,
  readSettingsFromDisk: vi.fn(),
  readSettingsFromDiskMigrated: vi.fn(async () => ({ persisted: true })),
  persistSettings: vi.fn(),
  sanitizeProjects: vi.fn(() => []),
  validateDirectoryPath: vi.fn(),
  resolveProjectDirectory: vi.fn(),
  getProviderSources: vi.fn(),
  removeProviderConfig: vi.fn(),
  refreshOpenCodeAfterConfigChange: vi.fn(),
  buildOpenCodeUrl: vi.fn(),
  getOpenCodeAuthHeaders: vi.fn(() => ({})),
});

describe('settings route', () => {
  it('returns the full formatted response without the bootstrap query', async () => {
    const formatted = { themeId: 'default', summaryCustomAPIToken: 'response-secret-sentinel' };
    const formatSettingsResponse = vi.fn(() => formatted);
    const app = express();
    registerOpenCodeRoutes(app, createDependencies({ formatSettingsResponse }));

    const response = await request(app).get('/api/config/settings').expect(200);

    expect(response.body).toEqual(formatted);
    expect(formatSettingsResponse).toHaveBeenCalledWith({ persisted: true });
  });

  it('formats settings before projecting the bootstrap response', async () => {
    const formatted = { defaultModel: 'model', summaryCustomAPIToken: 'response-secret-sentinel' };
    const projected = { schemaVersion: 1, defaultModel: 'model' };
    const formatSettingsResponse = vi.fn(() => formatted);
    const app = express();
    registerOpenCodeRoutes(app, createDependencies({ formatSettingsResponse }));

    const response = await request(app).get('/api/config/settings?bootstrap=true').expect(200);

    expect(response.body).toEqual(projected);
    expect(formatSettingsResponse).toHaveBeenCalledWith({ persisted: true });
  });

  it('returns the version 1 bootstrap allowlist without secret sentinels', async () => {
    const formatted = {
      defaultModel: 'model',
      defaultVariant: 'variant',
      defaultAgent: 'agent',
      autoCreateWorktree: true,
      gitmojiEnabled: false,
      defaultFileViewerPreview: true,
      zenModel: 'zen-model',
      messageStreamTransport: 'sse',
      sttProvider: 'openai-compatible',
      sttServerUrl: 'https://stt.example.com/v1',
      sttModel: 'whisper-1',
      sttLocalModel: 'local-model',
      sttLanguage: 'en',
      responseStyleEnabled: true,
      responseStylePreset: 'concise',
      responseStyleCustomInstructions: 'Keep it brief.',
      summaryCustomAPIToken: 'response-secret-sentinel',
      themeId: 'default',
    };
    const formatSettingsResponse = vi.fn(() => formatted);
    const app = express();
    registerOpenCodeRoutes(app, createDependencies({ formatSettingsResponse }));

    const response = await request(app).get('/api/config/settings/bootstrap').expect(200);

    expect(response.body).toEqual({
      schemaVersion: 1,
      defaultModel: 'model',
      defaultVariant: 'variant',
      defaultAgent: 'agent',
      autoCreateWorktree: true,
      gitmojiEnabled: false,
      defaultFileViewerPreview: true,
      zenModel: 'zen-model',
      messageStreamTransport: 'sse',
      sttProvider: 'openai-compatible',
      sttServerUrl: 'https://stt.example.com/v1',
      sttModel: 'whisper-1',
      sttLocalModel: 'local-model',
      sttLanguage: 'en',
      responseStyleEnabled: true,
      responseStylePreset: 'concise',
      responseStyleCustomInstructions: 'Keep it brief.',
    });
    expect(JSON.stringify(response.body)).not.toContain('secret-sentinel');
    expect(formatSettingsResponse).toHaveBeenCalledWith({ persisted: true });
  });
});

describe('behavior AGENTS.md route', () => {
  it('maps a missing file to an authoritative empty response', async () => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const readFile = vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(error);
    const app = express();
    registerOpenCodeRoutes(app, createDependencies({ formatSettingsResponse: vi.fn(() => ({})) }));

    const response = await request(app).get('/api/behavior/agents-md').expect(200);

    expect(response.body).toEqual({ content: '', exists: false });
    readFile.mockRestore();
  });

  it('keeps permission and I/O failures as server errors', async () => {
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    const readFile = vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(error);
    const app = express();
    registerOpenCodeRoutes(app, createDependencies({ formatSettingsResponse: vi.fn(() => ({})) }));

    const response = await request(app).get('/api/behavior/agents-md').expect(500);

    expect(response.body).toEqual({ error: 'Failed to read AGENTS.md' });
    readFile.mockRestore();
  });
});

describe('opencode2 upgrade pin (ticket 12)', () => {
  const createUpgradeApp = (overrides = {}) => {
    const app = express();
    app.use(express.json());
    const deps = {
      ...createDependencies({ formatSettingsResponse: vi.fn(() => ({})) }),
      getOpenCodeResolutionSnapshot: vi.fn(async () => ({ source: 'path', resolved: '/usr/local/bin/opencode' })),
      buildOpenCodeUrl: vi.fn((pathname) => `http://opencode.test${pathname}`),
      getOpenCodeAuthHeaders: vi.fn(() => ({ Authorization: 'Basic secret' })),
      refreshOpenCodeAfterConfigChange: vi.fn(async () => undefined),
      getResolvedOpenCodeBinarySource: vi.fn(() => 'path'),
      getResolvedOpenCodeBinary: vi.fn(() => '/usr/local/bin/opencode'),
      getActiveSessionCount: vi.fn(() => 0),
      ...overrides,
    };
    registerOpenCodeRoutes(app, deps);
    return { app, deps };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects 1.x upgrade targets even for owned cache', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { app } = createUpgradeApp({
      getOpenCodeResolutionSnapshot: vi.fn(async () => ({
        source: 'installed',
        resolved: '/tmp/openchamber/opencode-cli/2.0.12/opencode',
      })),
      getResolvedOpenCodeBinarySource: vi.fn(() => 'installed'),
      getResolvedOpenCodeBinary: vi.fn(() => '/tmp/openchamber/opencode-cli/2.0.12/opencode'),
      openchamberDataDir: '/tmp/openchamber',
    });

    const response = await request(app)
      .post('/api/opencode/upgrade')
      .send({ target: '1.18.4' })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatch(/1\.x/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('upgrade-status reports manual guidance for global CLI and never claims in-app available', async () => {
    const fetchMock = vi.fn(async (url) => {
      const href = String(url);
      if (href.includes('/api/info')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: '2.0.12', healthy: true }),
        };
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { app } = createUpgradeApp();

    const response = await request(app).get('/api/opencode/upgrade-status').expect(200);

    expect(response.body.canManage).toBe(false);
    expect(response.body.available).toBeNull();
    expect(response.body.management).toBe('manual-global');
    expect(response.body.guidance).toMatch(/global/i);
    expect(response.body.latestVersion).not.toMatch(/^v?1\./);
    expect(isOpenCode1xVersion(response.body.latestVersion)).toBe(false);
    expect(response.body.contract).toBeTruthy();
  });

  it('returns 409 for external OpenCode and does not restart', async () => {
    const restartOpenCode = vi.fn(async () => undefined);
    const refreshOpenCodeAfterConfigChange = vi.fn(async () => undefined);
    const { app, deps } = createUpgradeApp({
      getIsExternalOpenCode: () => true,
      restartOpenCode,
      refreshOpenCodeAfterConfigChange,
    });

    const response = await request(app)
      .post('/api/opencode/upgrade')
      .send({})
      .expect(409);

    expect(response.body.success).toBe(false);
    expect(response.body.management).toBe('manual-external');
    expect(response.body.error).toMatch(/external/i);
    expect(deps.restartOpenCode).not.toHaveBeenCalled();
    expect(deps.refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
  });

  it('upgrades a shared service using the owned cache and verifies the running version', async () => {
    const binary = '/cache/opencode-cli/2.0.14/opencode';
    vi.mocked(installPinnedOpenCode2Cli).mockResolvedValueOnce(binary);
    vi.mocked(readOpenCode2BinaryVersion).mockReturnValueOnce('2.0.14');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '2.0.14', pid: 42 }))));
    let resolvedBinary = '/usr/local/bin/opencode';
    const restartOpenCode = vi.fn(async () => {});
    const { app } = createUpgradeApp({
      getIsExternalOpenCode: () => true,
      getIsSharedOpenCodeService: () => true,
      getResolvedOpenCodeBinary: () => resolvedBinary,
      getOpenCodeCliVersion: () => '2.0.14',
      forceResolvedOpenCodeBinary: (value) => { resolvedBinary = value; },
      restartOpenCode,
      waitForOpenCodeReady: vi.fn(),
      openchamberDataDir: '/cache',
    });

    const response = await request(app).post('/api/opencode/upgrade').send({ target: '2.0.14' }).expect(200);
    expect(restartOpenCode).toHaveBeenCalledWith({ binaryPath: binary });
    expect(response.body).toMatchObject({ success: true, version: '2.0.14', ownership: 'shared-service' });
  });

  it('does not report a failed shared replacement as success and restores binary selection', async () => {
    vi.mocked(installPinnedOpenCode2Cli).mockResolvedValueOnce('/cache/opencode-cli/2.0.14/opencode');
    vi.mocked(readOpenCode2BinaryVersion).mockReturnValueOnce('2.0.14');
    const forceResolvedOpenCodeBinary = vi.fn();
    const { app } = createUpgradeApp({
      getIsExternalOpenCode: () => true,
      getIsSharedOpenCodeService: () => true,
      forceResolvedOpenCodeBinary,
      restartOpenCode: vi.fn(async () => { throw new Error('replacement failed'); }),
    });
    const response = await request(app).post('/api/opencode/upgrade').send({ target: '2.0.14' }).expect(500);
    expect(response.body).toMatchObject({ upgraded: false, error: 'replacement failed' });
    expect(forceResolvedOpenCodeBinary).toHaveBeenLastCalledWith('/usr/local/bin/opencode', 'path');
  });

  it('exposes shared upgrade availability while retaining active-task confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '2.0.10', pid: 42 }))));
    const restartOpenCode = vi.fn();
    const { app } = createUpgradeApp({
      getIsExternalOpenCode: () => true,
      getIsSharedOpenCodeService: () => true,
      getActiveSessionCount: () => 1,
      restartOpenCode,
    });
    const status = await request(app).get('/api/opencode/upgrade-status').expect(200);
    expect(status.body).toMatchObject({ canManage: true, available: true, ownership: 'shared-service' });
    const response = await request(app).post('/api/opencode/upgrade').send({}).expect(409);
    expect(response.body.errorCode).toBe('UPGRADE_ACTIVE_TASKS');
    expect(restartOpenCode).not.toHaveBeenCalled();
  });

  it.each(['unreachable', 'old-version'])('rejects shared upgrade verification when the running service is %s', async (mode) => {
    const binary = '/cache/opencode-cli/2.0.14/opencode';
    vi.mocked(installPinnedOpenCode2Cli).mockResolvedValueOnce(binary);
    vi.mocked(readOpenCode2BinaryVersion).mockReturnValueOnce('2.0.14');
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (mode === 'unreachable') throw new Error('offline');
      return new Response(JSON.stringify({ version: '2.0.12', pid: 42 }));
    }));
    const { app } = createUpgradeApp({
      getIsExternalOpenCode: () => true,
      getIsSharedOpenCodeService: () => true,
      getResolvedOpenCodeBinary: () => binary,
      getOpenCodeServeVersion: () => '2.0.14',
      getOpenCodeCliVersion: () => '2.0.14',
      getRuntimeContract: () => ({ reachable: true, authenticated: true, healthOk: true }),
      forceResolvedOpenCodeBinary: vi.fn(),
      restartOpenCode: vi.fn(),
    });
    const response = await request(app).post('/api/opencode/upgrade').send({ target: '2.0.14' }).expect(500);
    expect(response.body.upgraded).toBe(false);
  });

  it('refuses in-app upgrade when managed process uses global CLI', async () => {
    const restartOpenCode = vi.fn(async () => undefined);
    const { app, deps } = createUpgradeApp({ restartOpenCode });

    const response = await request(app)
      .post('/api/opencode/upgrade')
      .send({ target: '2.0.14' })
      .expect(409);

    expect(response.body.success).toBe(false);
    expect(response.body.ownership).toBe('global-cli');
    expect(deps.restartOpenCode).not.toHaveBeenCalled();
  });
});

describe('runtime contract routes (ticket 11)', () => {
  const createContractApp = (overrides = {}) => {
    const app = express();
    const deps = {
      ...createDependencies({ formatSettingsResponse: vi.fn(() => ({})) }),
      getOpenCodeResolutionSnapshot: vi.fn(async () => ({ source: 'path' })),
      buildOpenCodeUrl: vi.fn((pathname) => `http://opencode.test${pathname}`),
      getOpenCodeAuthHeaders: vi.fn(() => ({ Authorization: 'Basic secret' })),
      ...overrides,
    };
    registerOpenCodeRoutes(app, deps);
    return { app, deps };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes contract admission separate from bare healthy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ version: '2.0.12', pid: 1 }),
    })));
    const { app } = createContractApp();

    const health = await request(app).get('/api/opencode/health').expect(200);
    expect(health.body.healthy).toBe(true);
    expect(health.body.contract.protocolCompatible).toBe(true);
    expect(health.body.executionAllowed).toBe(true);

    const contract = await request(app).get('/api/opencode/contract').expect(200);
    expect(contract.body.serveVersion).toBe('2.0.12');
    expect(contract.body.capabilities['core.protocol'].available).toBe(true);
  });

  it('marks older 2.x healthy-reachability may still fail execution admission', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ version: '2.0.5', pid: 1 }),
    })));
    const { app } = createContractApp();
    const health = await request(app).get('/api/opencode/health').expect(200);
    // evaluateOpenCodeHealthBody still accepts any 2.x for reachability
    expect(health.body.healthy).toBe(true);
    expect(health.body.executionAllowed).toBe(false);
    expect(health.body.contract.phase).toBe('incompatible');
  });
});

describe('GET /api/opencode/health', () => {
  const createHealthApp = () => {
    const app = express();
    const deps = {
      ...createDependencies({ formatSettingsResponse: vi.fn(() => ({})) }),
      buildOpenCodeUrl: vi.fn((pathname) => `http://opencode.test${pathname}`),
      getOpenCodeAuthHeaders: vi.fn(() => ({ Authorization: 'Basic secret' })),
    };
    registerOpenCodeRoutes(app, deps);
    return { app, deps };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('admits official 2.x ServerInfo from /api/info without a healthy field', async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(String(url)).toContain('/api/info');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          version: '2.0.12',
          pid: 4242,
          urls: { api: 'http://127.0.0.1:4096' },
          paths: { config: '/tmp/config', data: '/tmp/data' },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { app } = createHealthApp();

    const response = await request(app).get('/api/opencode/health').expect(200);

    expect(response.body).toMatchObject({
      healthy: true,
      version: '2.0.12',
      executionAllowed: true,
      protocolCompatible: true,
    });
    expect(response.body.contract).toBeTruthy();
    // buildLiveContract also probes /api/info
    expect(fetchMock).toHaveBeenCalled();
  });

  it('rejects classic unhealthy bodies even when version is 2.x', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ healthy: false, version: '2.0.12' }),
    })));
    const { app } = createHealthApp();

    const response = await request(app).get('/api/opencode/health').expect(200);

    expect(response.body).toMatchObject({ healthy: false });
  });

  it('rejects 1.x bodies even when healthy:true is present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ healthy: true, version: '1.18.18' }),
    })));
    const { app } = createHealthApp();

    const response = await request(app).get('/api/opencode/health').expect(200);

    expect(response.body).toMatchObject({
      healthy: false,
      executionAllowed: false,
    });
  });

  it('returns healthy:false with error when upstream /api/info is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => ({ error: 'upstream down' }),
    })));
    const { app } = createHealthApp();

    const response = await request(app).get('/api/opencode/health').expect(502);

    expect(response.body).toMatchObject({ healthy: false, error: 'upstream down' });
    expect(response.body.contract).toBeTruthy();
  });
});
