import { createProjectIdFromPath } from '../projects/project-id.js';
import { projectBootstrapSettingsResponse } from './settings-helpers.js';
import {
  PINNED_OPENCODE2_VERSION,
  evaluateOpenCodeHealthBody,
  isOpenCode1xVersion,
  resolveOpenCode2UpgradeTarget,
} from './opencode2-pin.js';
import {
  installPinnedOpenCode2Cli,
  readOpenCode2BinaryVersion,
  resolveOpenChamberDataDir,
} from './ensure-cli.js';
import { evaluateRuntimeContract } from './runtime-contract.js';
import {
  buildUpgradeStatusSnapshot,
  classifyRuntimeOwnership,
  createUpgradeOperationState,
  evaluateOwnedUpgradeResult,
  resolveOwnedCacheBinaryPath,
} from './owned-runtime-upgrade.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const registerOpenCodeRoutes = (app, dependencies) => {
  const {
    crypto,
    clientReloadDelayMs,
    getOpenCodeResolutionSnapshot,
    formatSettingsResponse,
    readSettingsFromDisk,
    readSettingsFromDiskMigrated,
    persistSettings,
    sanitizeProjects,
    validateDirectoryPath,
    resolveProjectDirectory,
    getProviderSources,
    removeProviderConfig,
    refreshOpenCodeAfterConfigChange,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    onSettingsPersisted,
    getIsExternalOpenCode = () => false,
    forceResolvedOpenCodeBinary = null,
    restartOpenCode = null,
    waitForOpenCodeReady = null,
    getRuntimeContract = () => null,
    getOpenCodeServeVersion = () => null,
    getOpenCodeCliVersion = () => null,
    getResolvedOpenCodeBinary = () => null,
    getResolvedOpenCodeBinarySource = () => null,
    getActiveSessionCount = () => 0,
    openchamberDataDir = null,
  } = dependencies;

  const upgradeOperation = createUpgradeOperationState();
  const resolveDataDir = () => openchamberDataDir || resolveOpenChamberDataDir();

  let authLibrary = null;
  const pendingMcpAuthContextByState = new Map();
  const PENDING_MCP_AUTH_TTL_MS = 30 * 60 * 1000;
  const getAuthLibrary = async () => {
    if (!authLibrary) {
      authLibrary = await import('./auth.js');
    }
    return authLibrary;
  };

  const normalizePendingString = (value) => {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed || null;
  };

  const isBundledOpenCodeBinaryActive = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const resolution = await getOpenCodeResolutionSnapshot(settings);
    return resolution?.source === 'bundled' || resolution?.detectedSourceNow === 'bundled';
  };

  const readOpenCodeCurrentVersion = async () => {
    const healthResponse = await fetch(buildOpenCodeUrl('/api/info', ''), {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
    });
    const health = await healthResponse.json().catch(() => null);
    if (!healthResponse.ok) {
      return {
        ok: false,
        status: healthResponse.status,
        error: health?.error || healthResponse.statusText,
        authenticated: healthResponse.status === 401 || healthResponse.status === 403 ? false : null,
      };
    }
    const gate = evaluateOpenCodeHealthBody(health);
    const currentVersion = gate.version
      || (typeof health?.version === 'string' ? health.version.replace(/^v/, '') : null);
    return { ok: gate.ok, currentVersion, healthOk: gate.ok, authenticated: true };
  };

  const resolveOwnershipContext = async () => {
    const isExternal = getIsExternalOpenCode() === true;
    let binarySource = typeof getResolvedOpenCodeBinarySource === 'function'
      ? getResolvedOpenCodeBinarySource()
      : null;
    let binaryPath = typeof getResolvedOpenCodeBinary === 'function'
      ? getResolvedOpenCodeBinary()
      : null;
    try {
      const settings = await readSettingsFromDiskMigrated();
      const resolution = await getOpenCodeResolutionSnapshot(settings);
      binarySource = binarySource || resolution?.source || resolution?.detectedSourceNow || null;
      binaryPath = binaryPath || resolution?.resolved || null;
      if (resolution?.source === 'bundled' || resolution?.detectedSourceNow === 'bundled') {
        binarySource = 'bundled';
      }
    } catch {
      // Resolution failures still allow ownership classification from runtime flags.
    }
    return classifyRuntimeOwnership({
      isExternal,
      binarySource,
      binaryPath,
      dataDir: resolveDataDir(),
    });
  };

  const buildLiveContract = async () => {
    const cached = typeof getRuntimeContract === 'function' ? getRuntimeContract() : null;
    const serveProbe = await readOpenCodeCurrentVersion().catch(() => ({ ok: false, currentVersion: null }));
    const serveVersion = serveProbe.currentVersion
      || (typeof getOpenCodeServeVersion === 'function' ? getOpenCodeServeVersion() : null);
    const binaryPath = typeof getResolvedOpenCodeBinary === 'function' ? getResolvedOpenCodeBinary() : null;
    const cliVersion = (typeof getOpenCodeCliVersion === 'function' ? getOpenCodeCliVersion() : null)
      || (binaryPath ? readOpenCode2BinaryVersion(binaryPath) : null)
      || null;
    return evaluateRuntimeContract({
      serveVersion,
      cliVersion,
      reachable: serveProbe.ok === true || Boolean(serveVersion) || Boolean(cached?.reachable),
      authenticated: serveProbe.authenticated ?? cached?.authenticated ?? null,
      healthOk: serveProbe.healthOk ?? serveProbe.ok ?? cached?.healthOk ?? null,
      migrationAdmitTranscript: cached?.migrationExecutable ?? null,
      migrationPhase: cached?.migrationPhase ?? null,
      migrationError: cached?.migrationError ?? null,
    });
  };

  const buildUpgradeStatus = async () => {
    const ownership = await resolveOwnershipContext();
    const contract = await buildLiveContract();
    const activeCount = typeof getActiveSessionCount === 'function' ? Number(getActiveSessionCount()) || 0 : 0;
    return buildUpgradeStatusSnapshot({
      ownership,
      serveVersion: contract.serveVersion,
      cliVersion: contract.cliVersion,
      targetVersion: PINNED_OPENCODE2_VERSION,
      contract,
      operation: upgradeOperation.getState(),
      hasActiveTasks: activeCount > 0,
    });
  };

  const parseVersionForComparison = (value) => {
    const normalized = String(value || '').replace(/^v/, '').split('+')[0];
    const prereleaseIndex = normalized.indexOf('-');
    const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
    const parts = core.split('.').map((part) => {
      const parsed = Number.parseInt(part || '0', 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
    return { parts, prerelease: prereleaseIndex >= 0 };
  };

  const compareVersions = (left, right) => {
    const a = parseVersionForComparison(left);
    const b = parseVersionForComparison(right);
    const length = Math.max(a.parts.length, b.parts.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
      if (diff !== 0) return diff;
    }
    if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1;
    return 0;
  };

  const fetchLatestOpenCodeVersionFromGithub = async () => {
    const response = await fetch('https://api.github.com/repos/anomalyco/opencode/releases/latest', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`OpenCode releases responded with ${response.status}`);
    }
    const payload = await response.json();
    const tag = typeof payload?.tag_name === 'string' ? payload.tag_name.trim() : '';
    return tag.replace(/^v/, '');
  };

  const fetchLatestOpenCodeVersionFromNpm = async () => {
    const response = await fetch('https://registry.npmjs.org/opencode-ai/latest', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`OpenCode npm registry responded with ${response.status}`);
    }
    const payload = await response.json();
    return typeof payload?.version === 'string' ? payload.version.trim().replace(/^v/, '') : '';
  };

  const fetchLatestOpenCodeVersion = async () => {
    const results = await Promise.allSettled([
      fetchLatestOpenCodeVersionFromNpm(),
      fetchLatestOpenCodeVersionFromGithub(),
    ]);
    const versions = results
      .filter((result) => result.status === 'fulfilled' && result.value)
      .map((result) => result.value);
    if (versions.length === 0) {
      const failure = results.find((result) => result.status === 'rejected');
      throw failure?.reason instanceof Error ? failure.reason : new Error('Failed to resolve latest OpenCode version');
    }
    return versions.sort((left, right) => compareVersions(right, left))[0];
  };

  const pruneExpiredPendingMcpAuthContexts = () => {
    const now = Date.now();
    for (const [state, entry] of pendingMcpAuthContextByState.entries()) {
      if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) {
        pendingMcpAuthContextByState.delete(state);
      }
    }
  };

  const normalizeOpenCodeUpgradeTarget = (value) => {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/^v/i, '');
  };

  const readOpenCodeUpgradeError = (payload, fallback) => {
    if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim();
    if (typeof payload?.data?.message === 'string' && payload.data.message.trim()) {
      return payload.data.message.trim();
    }
    if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message.trim();
    return fallback;
  };

  app.get('/api/config/settings', async (req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      const response = formatSettingsResponse(settings);
      res.json(req.query?.bootstrap === 'true' ? projectBootstrapSettingsResponse(response) : response);
    } catch (error) {
      console.error('Failed to read settings:', error);
      res.status(500).json({ error: 'Failed to read settings' });
    }
  });

  app.get('/api/config/settings/bootstrap', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      const response = formatSettingsResponse(settings);
      res.json(projectBootstrapSettingsResponse(response));
    } catch (error) {
      console.error('Failed to read bootstrap settings:', error);
      res.status(500).json({ error: 'Failed to read bootstrap settings' });
    }
  });

  app.get('/api/config/opencode-resolution', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      const resolution = await getOpenCodeResolutionSnapshot(settings);
      res.json(resolution);
    } catch (error) {
      console.error('Failed to resolve OpenCode binary:', error);
      res.status(500).json({ error: 'Failed to resolve OpenCode binary' });
    }
  });

  app.post('/api/opencode/upgrade', async (req, res) => {
    try {
      const ownership = await resolveOwnershipContext();
      if (!ownership.canUpgradeInApp) {
        const status = ownership.ownership === 'external-serve' || ownership.ownership === 'bundled' ? 409 : 409;
        return res.status(status).json({
          success: false,
          error: ownership.guidance
            || 'OpenChamber can only upgrade its owned OpenCode cache in-app.',
          errorCode: ownership.reason || 'UPGRADE_NOT_MANAGED',
          ownership: ownership.ownership,
          management: ownership.management,
          guidance: ownership.guidance,
        });
      }

      const rawTarget = typeof req.body?.target === 'string' && req.body.target.trim().length > 0
        ? req.body.target.trim()
        : undefined;
      if (isOpenCode1xVersion(rawTarget)) {
        return res.status(400).json({
          success: false,
          error: 'OpenCode upgrade refuses 1.x targets. Only pinned opencode2 is allowed.',
          errorCode: 'OPENCODE_UPGRADE_1X_REFUSED',
        });
      }
      const target = resolveOpenCode2UpgradeTarget(rawTarget);
      const confirmActive = req.body?.confirmActiveTasks === true || req.body?.force === true;
      const activeCount = typeof getActiveSessionCount === 'function' ? Number(getActiveSessionCount()) || 0 : 0;
      if (activeCount > 0 && !confirmActive) {
        return res.status(409).json({
          success: false,
          error: 'OpenCode has active sessions. Confirm upgrade to interrupt them, or wait until idle.',
          errorCode: 'UPGRADE_ACTIVE_TASKS',
          hasActiveTasks: true,
          activeSessionCount: activeCount,
        });
      }

      const begin = upgradeOperation.begin(target);
      if (!begin.ok) {
        return res.status(begin.status).json(begin.body);
      }

      const expectedBinaryPath = resolveOwnedCacheBinaryPath(target, { dataDir: resolveDataDir() });
      let installedPath = expectedBinaryPath;

      try {
        upgradeOperation.setPhase('download');
        installedPath = await installPinnedOpenCode2Cli({
          version: target,
          dataDir: resolveDataDir(),
        });
        const diskVersion = readOpenCode2BinaryVersion(installedPath);
        if (diskVersion !== target) {
          const error = new Error(
            `Owned-cache binary version mismatch after install: expected ${target}, got ${diskVersion || 'unknown'}`,
          );
          error.code = 'UPGRADE_BINARY_VERSION_MISMATCH';
          throw error;
        }

        upgradeOperation.setPhase('pin-binary', { binaryPath: installedPath });
        if (typeof forceResolvedOpenCodeBinary !== 'function') {
          const error = new Error('Owned-cache upgrade requires forceResolvedOpenCodeBinary');
          error.code = 'UPGRADE_FORCE_BINARY_UNAVAILABLE';
          throw error;
        }
        // Keep target identity through restart — do not rediscover global CLI.
        forceResolvedOpenCodeBinary(installedPath, 'installed');

        upgradeOperation.setPhase('restart');
        if (typeof restartOpenCode === 'function') {
          await restartOpenCode();
        } else if (typeof refreshOpenCodeAfterConfigChange === 'function') {
          // Fallback: still pin binary first so restart prefers owned cache.
          await refreshOpenCodeAfterConfigChange('OpenCode owned-cache upgrade');
        } else {
          const error = new Error('No OpenCode restart path is configured');
          error.code = 'UPGRADE_RESTART_UNAVAILABLE';
          throw error;
        }

        if (typeof waitForOpenCodeReady === 'function') {
          upgradeOperation.setPhase('wait-ready');
          await waitForOpenCodeReady();
        }

        upgradeOperation.setPhase('verify');
        // Re-pin after restart helpers that may clear resolution.
        forceResolvedOpenCodeBinary(installedPath, 'installed');
        const contract = await buildLiveContract();
        const verification = evaluateOwnedUpgradeResult({
          targetVersion: target,
          serveVersion: contract.serveVersion,
          cliVersion: contract.cliVersion,
          binaryPath: typeof getResolvedOpenCodeBinary === 'function'
            ? getResolvedOpenCodeBinary()
            : installedPath,
          expectedBinaryPath: installedPath,
          contract,
        });
        if (!verification.ok) {
          const error = new Error(verification.error);
          error.code = verification.errorCode;
          error.serveVersion = verification.serveVersion;
          error.contract = verification.contract;
          throw error;
        }

        upgradeOperation.succeed({
          serveVersion: verification.serveVersion,
          binaryPath: installedPath,
        });
        return res.json({
          success: true,
          upgraded: true,
          restarted: true,
          version: verification.serveVersion,
          targetVersion: target,
          pinned: true,
          supplySource: 'owned-cache',
          ownership: 'owned-cache',
          binaryPath: installedPath,
          contract: verification.contract,
          operation: upgradeOperation.getState(),
        });
      } catch (upgradeError) {
        const message = upgradeError instanceof Error ? upgradeError.message : 'Failed to upgrade OpenCode';
        const errorCode = upgradeError?.code || 'UPGRADE_FAILED';
        upgradeOperation.fail({
          error: message,
          errorCode,
          phase: upgradeOperation.getState().phase,
          serveVersion: upgradeError?.serveVersion ?? null,
          binaryPath: installedPath,
        });
        // Preserve previous owned cache on disk; only report failure.
        return res.status(500).json({
          success: false,
          upgraded: false,
          error: message,
          errorCode,
          targetVersion: target,
          operation: upgradeOperation.getState(),
          contract: upgradeError?.contract || null,
        });
      }
    } catch (error) {
      console.error('Failed to upgrade OpenCode:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to upgrade OpenCode',
      });
    }
  });

  app.get('/api/opencode/upgrade-status', async (_req, res) => {
    try {
      const status = await buildUpgradeStatus();
      return res.json(status);
    } catch (error) {
      return res.status(500).json({
        available: null,
        error: error instanceof Error ? error.message : 'Failed to check OpenCode upgrade status',
        operation: upgradeOperation.getState(),
      });
    }
  });

  app.get('/api/opencode/contract', async (_req, res) => {
    try {
      const contract = await buildLiveContract();
      const ownership = await resolveOwnershipContext();
      return res.json({
        ...contract,
        ownership: ownership.ownership,
        supplySource: ownership.supplySource,
        canManageUpgrade: ownership.canUpgradeInApp,
        management: ownership.management,
        guidance: ownership.guidance,
      });
    } catch (error) {
      return res.status(500).json({
        schemaVersion: 1,
        phase: 'unknown',
        executionAllowed: false,
        error: error instanceof Error ? error.message : 'Failed to evaluate OpenCode runtime contract',
      });
    }
  });

  app.get('/api/opencode/health', async (_req, res) => {
    try {
      const healthResponse = await fetch(buildOpenCodeUrl('/api/info', ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(4_000),
      });
      const health = await healthResponse.json().catch(() => null);
      if (!healthResponse.ok) {
        const contract = evaluateRuntimeContract({
          reachable: false,
          authenticated: healthResponse.status === 401 || healthResponse.status === 403 ? false : null,
          healthOk: false,
        });
        return res.status(healthResponse.status).json({
          healthy: false,
          error: health?.error || healthResponse.statusText || 'OpenCode health check failed',
          contract,
        });
      }
      // Reuse lifecycle/sidecar gate: official 2.x ServerInfo omits `healthy`.
      const gate = evaluateOpenCodeHealthBody(health);
      const contract = await buildLiveContract().catch(() => evaluateRuntimeContract({
        serveVersion: gate.version,
        reachable: gate.ok,
        authenticated: true,
        healthOk: gate.ok,
      }));
      return res.json({
        healthy: gate.ok,
        version: gate.version,
        // Healthy is reachability/version shape only — not full execution semantics.
        executionAllowed: contract.executionAllowed === true,
        protocolCompatible: contract.protocolCompatible === true,
        contract,
      });
    } catch (error) {
      return res.status(503).json({
        healthy: false,
        error: error instanceof Error ? error.message : 'OpenCode health check failed',
        contract: evaluateRuntimeContract({ reachable: false, healthOk: false }),
      });
    }
  });

  app.get('/api/opencode/version', async (_req, res) => {
    try {
      const contract = await buildLiveContract();
      const healthResponse = await fetch(buildOpenCodeUrl('/api/info', ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      });
      const health = await healthResponse.json().catch(() => null);
      if (!healthResponse.ok) {
        return res.status(healthResponse.status).json({
          version: null,
          serveVersion: null,
          cliVersion: contract.cliVersion,
          error: health?.error || healthResponse.statusText || 'Failed to read OpenCode version',
          contract,
        });
      }
      const version = typeof health?.version === 'string' ? health.version.replace(/^v/, '') : null;
      return res.json({
        version,
        serveVersion: version,
        cliVersion: contract.cliVersion,
        versionMismatch: Boolean(version && contract.cliVersion && version !== contract.cliVersion),
        contract,
      });
    } catch (error) {
      return res.status(500).json({
        version: null,
        error: error instanceof Error ? error.message : 'Failed to read OpenCode version',
      });
    }
  });

  app.put('/api/config/settings', async (req, res) => {
    try {
      const changes = req.body ?? {};
      const updated = await persistSettings(changes);
      // Only after a successful persist — failed saves must not apply runtime flags.
      if (
        typeof onSettingsPersisted === 'function'
        && Object.prototype.hasOwnProperty.call(changes, 'questionAutoDelegateEnabled')
      ) {
        try {
          onSettingsPersisted(updated, changes);
        } catch (error) {
          console.warn('[API:PUT /api/config/settings] onSettingsPersisted failed:', error?.message ?? error);
        }
      }
      res.json(updated);
    } catch (error) {
      console.error('[API:PUT /api/config/settings] Failed to save settings:', error);
      console.error('[API:PUT /api/config/settings] Error stack:', error.stack);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  app.post('/api/mcp/auth/pending', async (req, res) => {
    try {
      pruneExpiredPendingMcpAuthContexts();

      const state = normalizePendingString(req.body?.state);
      if (!state) {
        return res.json({ success: true, context: null });
      }

      const name = normalizePendingString(req.body?.name);
      if (!name) {
        return res.status(400).json({ error: 'MCP server name is required' });
      }

      const entry = {
        name,
        directory: normalizePendingString(req.body?.directory),
        expiresAt: Date.now() + PENDING_MCP_AUTH_TTL_MS,
      };
      pendingMcpAuthContextByState.set(state, entry);

      return res.json({
        success: true,
        context: {
          name: entry.name,
          directory: entry.directory,
        },
      });
    } catch (error) {
      console.error('Failed to store pending MCP auth context:', error);
      return res.status(500).json({ error: error.message || 'Failed to store pending MCP auth context' });
    }
  });

  app.get('/api/mcp/auth/pending', async (req, res) => {
    try {
      pruneExpiredPendingMcpAuthContexts();

      const state = normalizePendingString(Array.isArray(req.query?.state) ? req.query.state[0] : req.query?.state);
      if (!state) {
        return res.json(null);
      }

      const pendingMcpAuthContext = pendingMcpAuthContextByState.get(state) ?? null;
      if (!pendingMcpAuthContext) {
        return res.status(404).json({ error: 'No pending MCP auth context' });
      }

      return res.json(pendingMcpAuthContext);
    } catch (error) {
      console.error('Failed to read pending MCP auth context:', error);
      return res.status(500).json({ error: error.message || 'Failed to read pending MCP auth context' });
    }
  });

  app.delete('/api/mcp/auth/pending', async (req, res) => {
    try {
      const state = normalizePendingString(Array.isArray(req.query?.state) ? req.query.state[0] : req.query?.state);
      if (!state) {
        return res.json({ success: true });
      }

      pendingMcpAuthContextByState.delete(state);
      return res.json({ success: true });
    } catch (error) {
      console.error('Failed to clear pending MCP auth context:', error);
      return res.status(500).json({ error: error.message || 'Failed to clear pending MCP auth context' });
    }
  });

  app.get('/api/provider/:providerId/source', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;

      let directory = null;
      const resolved = await resolveProjectDirectory(req);
      if (resolved.directory) {
        directory = resolved.directory;
      } else if (requestedDirectory) {
        return res.status(400).json({ error: resolved.error });
      }

      const sources = getProviderSources(providerId, directory);
      const { getProviderAuth } = await getAuthLibrary();
      const auth = getProviderAuth(providerId);
      sources.sources.auth.exists = Boolean(auth);

      return res.json({
        providerId,
        sources: sources.sources,
      });
    } catch (error) {
      console.error('Failed to get provider sources:', error);
      return res.status(500).json({ error: error.message || 'Failed to get provider sources' });
    }
  });

  app.delete('/api/provider/:providerId/auth', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const scope = typeof req.query?.scope === 'string' ? req.query.scope : 'auth';
      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;
      let directory = null;

      if (scope === 'project' || requestedDirectory) {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({ error: resolved.error });
        }
        directory = resolved.directory;
      } else {
        const resolved = await resolveProjectDirectory(req);
        if (resolved.directory) {
          directory = resolved.directory;
        }
      }

      let removed = false;
      if (scope === 'auth') {
        const { removeProviderAuth } = await getAuthLibrary();
        removed = removeProviderAuth(providerId);
      } else if (scope === 'user' || scope === 'project' || scope === 'custom') {
        removed = removeProviderConfig(providerId, directory, scope);
      } else if (scope === 'all') {
        const { removeProviderAuth } = await getAuthLibrary();
        const authRemoved = removeProviderAuth(providerId);
        const userRemoved = removeProviderConfig(providerId, directory, 'user');
        const projectRemoved = directory ? removeProviderConfig(providerId, directory, 'project') : false;
        const customRemoved = removeProviderConfig(providerId, directory, 'custom');
        removed = authRemoved || userRemoved || projectRemoved || customRemoved;
      } else {
        return res.status(400).json({ error: 'Invalid scope' });
      }

      if (removed) {
        await refreshOpenCodeAfterConfigChange(`provider ${providerId} disconnected (${scope})`);
      }

      return res.json({
        success: true,
        removed,
        requiresReload: removed,
        message: removed ? 'Provider disconnected successfully' : 'Provider was not connected',
        reloadDelayMs: removed ? clientReloadDelayMs : undefined,
      });
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      return res.status(500).json({ error: error.message || 'Failed to disconnect provider' });
    }
  });

  app.post('/api/opencode/directory', async (req, res) => {
    try {
      const requestedPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
      }

      const validated = await validateDirectoryPath(requestedPath);
      if (!validated.ok) {
        return res.status(400).json({ error: validated.error });
      }

      const resolvedPath = validated.directory;
      const currentSettings = await readSettingsFromDisk();
      const existingProjects = sanitizeProjects(currentSettings.projects) || [];
      const existing = existingProjects.find((project) => project.path === resolvedPath) || null;

      const nextProjects = existing
        ? existingProjects
        : [
            ...existingProjects,
            {
              id: createProjectIdFromPath(resolvedPath),
              path: resolvedPath,
              addedAt: Date.now(),
              lastOpenedAt: Date.now(),
            },
          ];

      const activeProjectId = existing ? existing.id : nextProjects[nextProjects.length - 1].id;

      const updated = await persistSettings({
        projects: nextProjects,
        activeProjectId,
        lastDirectory: resolvedPath,
      });

      return res.json({
        success: true,
        restarted: false,
        path: resolvedPath,
        settings: updated,
      });
    } catch (error) {
      console.error('Failed to update OpenCode working directory:', error);
      return res.status(500).json({ error: error.message || 'Failed to update working directory' });
    }
  });

  // Behavior / Global AGENTS.md endpoints
  const AGENTS_MD_PATH = path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md');
  const MAX_BEHAVIOR_PROMPT_SIZE = 1024 * 1024; // 1 MB

  app.get('/api/behavior/agents-md', async (_req, res) => {
    try {
      try {
        const content = await fs.promises.readFile(AGENTS_MD_PATH, 'utf8');
        return res.json({ content, exists: true });
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return res.json({ content: '', exists: false });
        }
        throw error;
      }
    } catch (error) {
      console.error('Failed to read AGENTS.md:', error);
      return res.status(500).json({ error: 'Failed to read AGENTS.md' });
    }
  });

  app.put('/api/behavior/agents-md', async (req, res) => {
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';

      if (content.length > MAX_BEHAVIOR_PROMPT_SIZE) {
        return res.status(413).json({ error: `Content exceeds maximum size of ${MAX_BEHAVIOR_PROMPT_SIZE} bytes` });
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(AGENTS_MD_PATH);
      try {
        await fs.promises.access(parentDir);
      } catch {
        await fs.promises.mkdir(parentDir, { recursive: true });
      }

      await fs.promises.writeFile(AGENTS_MD_PATH, content, 'utf8');

      // Refresh OpenCode so it picks up the new AGENTS.md without a full restart
      try {
        await refreshOpenCodeAfterConfigChange('global behavior (AGENTS.md) updated');
      } catch {
        // Non-fatal: file was written successfully
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('Failed to write AGENTS.md:', error);
      return res.status(500).json({ error: error.message || 'Failed to write AGENTS.md' });
    }
  });
};
