import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { registerManagedProcess, unregisterManagedProcess, reapOrphanedProcesses } from './managed-process-registry.js';
import { evaluateOpenCodeHealthBody } from './opencode2-pin.js';
import { readOpenCode2BinaryVersion } from './ensure-cli.js';
import { createRevokedRuntimeContract, evaluateRuntimeContract } from './runtime-contract.js';
import { OPENCODE_V1_MIGRATION_PATH, fetchV1MigrationGate } from './v1-migration-gate.js';
import { isProcessAlive } from './shared-service.js';

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const HEALTH_CHECK_TIMEOUT_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_TIMEOUT_MS, 5000);
const HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES = parsePositiveInt(
  process.env.OPENCHAMBER_OPENCODE_HEALTH_CONSECUTIVE_FAILURES,
  20
);
const HEALTH_CHECK_INTERVAL_OVERRIDE_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_INTERVAL_MS, 0);
const HEALTH_CHECK_RESULT_CACHE_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_CACHE_MS, 750);
// Official OpenCode 2.x exposes ServerInfo at GET /api/info (client.server.info).
const OPENCODE_HEALTH_PATH = '/api/info';
const OPENCODE_HEALTH_FALLBACK_PATH = '/global/health';
const DEFAULT_OPENCODE_SERVE_PORT = 4096;
// Polite SIGTERM window before SIGKILL for managed children (restart/OAuth/reload
// need enough time for clean flush; do not shorten globally for Quit latency).
const OPENCODE_CHILD_SIGTERM_GRACE_MS = 2500;
const OPENCODE_CHILD_SIGKILL_WAIT_MS = 1000;
// Last-used directory plus recently opened projects — deeper tails are unlikely
// to be the user's first click and just add background work.
const WARMUP_DIRECTORY_LIMIT = 4;
const WARMUP_REQUEST_TIMEOUT_MS = 30000;

export const createOpenCodeLifecycleRuntime = (deps) => {
  const {
    state,
    env,
    syncToHmrState,
    syncFromHmrState,
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    waitForReady,
    normalizeApiPrefix,
    applyOpencodeBinaryFromSettings,
    ensureOpencodeCliEnv,
    ensurePinnedOpenCode2CliEnv,
    ensureLocalOpenCodeServerPassword,
    resolveManagedOpenCodeLaunchSpec,
    setOpenCodePort,
    setDetectedOpenCodeApiPrefix,
    setupProxy,
    ensureOpenCodeApiPrefix,
    clearResolvedOpenCodeBinary,
    buildAugmentedPath,
    buildManagedOpenCodePath,
    getManagedOpenCodeShellEnvSnapshot,
    managedCapabilitiesRuntime = null,
    getActiveSessionCount = () => 0,
    getWarmupDirectories = async () => [],
    // Official background service (shared-service.js). null keeps the private
    // managed `opencode serve` path.
    sharedService = null,
    adoptOpenCodeServerPassword = null,
  } = deps;

  // Shared services outlive this runtime. Recovery re-ensures them; only an
  // explicit binary upgrade replaces them through the official service CLI.
  let sharedServiceAttached = false;
  let sharedServicePid = null;

  /**
   * Force-signal only an owned managed OpenCode pid / process group.
   * Never lsof-kill by port: that can murder clients still connected to the port
   * or a newly bound external/shared `opencode serve` that we do not own.
   * `port` is accepted for call-site compatibility and diagnostics only.
   */
  const killProcessOnPort = (port, ownedPid = null) => {
    const pid = Number(ownedPid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return;
    }
    if (pid === process.pid) {
      return;
    }

    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], {
          stdio: 'ignore',
          timeout: 5000,
          windowsHide: true,
        });
      } catch {
      }
      return;
    }

    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
    }
  };

  const hasChildProcessExited = (child) => !child || child.exitCode !== null || child.signalCode !== null;

  const isManagedOpenCodeProcessAlive = () => {
    const child = state.openCodeProcess;
    if (!child || hasChildProcessExited(child)) return false;
    if (!child.pid) return true;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const waitForChildProcessClose = (child, timeoutMs) => new Promise((resolve) => {
    if (!child || hasChildProcessExited(child)) {
      resolve(true);
      return;
    }

    let done = false;
    const finish = (closed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off('close', onClose);
      child.off('error', onError);
      resolve(closed);
    };

    const onClose = () => finish(true);
    const onError = () => finish(hasChildProcessExited(child));
    const timer = setTimeout(() => finish(hasChildProcessExited(child)), timeoutMs);

    child.once('close', onClose);
    child.once('error', onError);
  });

  const waitForPortRelease = (port, timeoutMs, hostname = env.ENV_CONFIGURED_OPENCODE_HOSTNAME) => {
    if (!port) {
      return Promise.resolve(true);
    }

    const probeHost = !hostname || hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]'
      ? '127.0.0.1'
      : hostname;
    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve) => {
      const attempt = () => {
        const socket = net.connect({ port, host: probeHost });
        let settled = false;

        const finish = (released) => {
          if (settled) return;
          settled = true;
          socket.removeAllListeners();
          socket.destroy();
          if (released || Date.now() >= deadline) {
            resolve(released);
            return;
          }
          setTimeout(attempt, 150);
        };

        socket.once('connect', () => finish(false));
        socket.once('timeout', () => finish(true));
        socket.once('error', (error) => {
          if (error && typeof error === 'object' && (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH')) {
            finish(true);
            return;
          }
          finish(false);
        });
        socket.setTimeout(500);
      };

      attempt();
    });
  };

  const terminateChildProcess = async (child) => {
    if (!child) {
      return;
    }

    const pid = child.pid;
    if (!pid || hasChildProcessExited(child)) {
      await waitForChildProcessClose(child, 250);
      return;
    }

    const signalProcessTree = (signal) => {
      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, signal);
        } catch {
        }
      }

      try {
        child.kill(signal);
      } catch {
      }
    };

    if (process.platform === 'win32') {
      try {
        child.kill();
      } catch {
      }

      if (await waitForChildProcessClose(child, 800)) {
        return;
      }

      try {
        spawnSync('taskkill', ['/pid', String(pid), '/t'], {
          stdio: 'ignore',
          timeout: 3000,
          windowsHide: true,
        });
      } catch {
      }

      if (await waitForChildProcessClose(child, 1500)) {
        return;
      }

      try {
        spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], {
          stdio: 'ignore',
          timeout: 5000,
          windowsHide: true,
        });
      } catch {
      }

      await waitForChildProcessClose(child, 3000);
      return;
    }

    signalProcessTree('SIGTERM');

    if (await waitForChildProcessClose(child, OPENCODE_CHILD_SIGTERM_GRACE_MS)) {
      return;
    }

    signalProcessTree('SIGKILL');

    await waitForChildProcessClose(child, OPENCODE_CHILD_SIGKILL_WAIT_MS);
  };

  const closeManagedOpenCodeChild = async (child) => {
    const pid = child?.pid;
    try {
      await terminateChildProcess(child);
    } finally {
      // Drop it from the registry only once it has actually exited, so a child
      // that survived teardown stays eligible for the next run's reaper.
      if (Number.isInteger(pid) && hasChildProcessExited(child)) {
        unregisterManagedProcess(pid);
      }
    }
  };

  const formatCapturedOutput = ({ stdout, stderr }) => {
    const parts = [];
    if (stdout.trim()) {
      parts.push(`stdout:\n${stdout.trim()}`);
    }
    if (stderr.trim()) {
      parts.push(`stderr:\n${stderr.trim()}`);
    }
    return parts.length > 0 ? parts.join('\n\n') : 'No stdout/stderr captured';
  };

  const createManagedOpenCodeServerProcess = async ({ hostname, port, timeout, cwd, env: processEnv, shellEnvKeysCount = 0 }) => {
    let binary = (process.env.OPENCODE_BINARY || 'opencode').trim() || 'opencode';
    let args = ['serve', '--hostname', hostname, '--port', String(port)];
    let launchWrapperType = null;

    if (process.platform === 'win32' && state.useWslForOpencode) {
      throw new Error('Launching OpenCode through WSL is no longer supported. Install OpenCode natively on Windows and configure opencode.cmd or opencode.exe.');
    }

    if (process.platform === 'win32' && !state.useWslForOpencode) {
      const launchSpec = resolveManagedOpenCodeLaunchSpec(binary);
      if (launchSpec?.binary) {
        if (launchSpec.wrapperType) {
          console.log(`Launching OpenCode via ${launchSpec.wrapperType}: ${launchSpec.binary}`);
        }
        launchWrapperType = launchSpec.wrapperType || null;
        binary = launchSpec.binary;
        args = [...(Array.isArray(launchSpec.args) ? launchSpec.args : []), ...args];
      }
    }

    const pathValue = typeof processEnv?.PATH === 'string' ? processEnv.PATH : '';
    const pathEntryCount = pathValue ? pathValue.split(process.platform === 'win32' ? ';' : ':').filter(Boolean).length : 0;
    state.lastOpenCodeLaunchDiagnostics = {
      launchedAt: new Date().toISOString(),
      binary,
      args,
      cwd,
      hostname,
      port,
      wrapperType: launchWrapperType,
      pathEntryCount,
      hasShellEnv: shellEnvKeysCount > 0,
      shellEnvKeysCount,
    };
    console.log('[OpenCode] Launching managed server', state.lastOpenCodeLaunchDiagnostics);

    const child = spawn(binary, args, {
      cwd,
      env: processEnv,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    managedCapabilitiesRuntime?.recordManagedChildPid(child.pid);
    state.managedCapabilityIdentity = managedCapabilitiesRuntime?.getCapabilityIdentity?.() ?? null;

    let url;
    try {
      url = await new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let done = false;
        const finish = (handler, value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          child.stdout?.off('data', onStdout);
          child.stderr?.off('data', onStderr);
          child.off('exit', onExit);
          child.off('error', onError);
          handler(value);
        };

        const onStdout = (chunk) => {
          stdout += chunk.toString();
          const lines = stdout.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            // v2 prints `server listening on http://...` without the `opencode `
            // prefix; 1.x still prints `opencode server listening on ...`.
            if (!trimmed.startsWith('opencode server listening') && !trimmed.startsWith('server listening')) continue;
            const match = trimmed.match(/on\s+(https?:\/\/[^\s]+)/);
            if (!match) {
              finish(reject, new Error(`Failed to parse server url from output: ${line}`));
              return;
            }
            finish(resolve, match[1]);
            return;
          }
        };

        const onStderr = (chunk) => {
          stderr += chunk.toString();
        };

        const onExit = (code, signal) => {
          const reason = signal ? `signal ${signal}` : `code ${code}`;
          const appBundleHint = process.platform === 'darwin' && /\/OpenCode\.app\/Contents\/MacOS\/(?:OpenCode|opencode-cli)$/i.test(binary)
            ? ' The configured binary appears to point at the macOS desktop app bundle; OpenChamber needs the standalone opencode CLI.'
            : '';
          finish(reject, new Error(`OpenCode process exited before serving with ${reason}. Binary used: ${binary}.${appBundleHint} ${formatCapturedOutput({ stdout, stderr })}`));
        };

        const onError = (error) => {
          finish(reject, error);
        };

        const timer = setTimeout(() => {
          finish(reject, new Error(`Timeout waiting for OpenCode to start after ${timeout}ms`));
        }, timeout);

        child.stdout?.on('data', onStdout);
        child.stderr?.on('data', onStderr);
        child.on('exit', onExit);
        child.on('error', onError);
      });
    } catch (error) {
      await closeManagedOpenCodeChild(child);
      throw error;
    }

    // Record this child so a future run can reap it if we crash before teardown.
    // The web-server lifecycle runs in-process inside multiple hosts, so tag the
    // actual host (Electron sets OPENCHAMBER_RUNTIME='desktop'; the standalone
    // web CLI leaves it unset → 'web'; SSH remote → 'ssh-remote') rather than a
    // hardcoded label, matching the server's existing runtimeName convention.
    registerManagedProcess({
      pid: child.pid,
      ownerPid: process.pid,
      port,
      binary,
      runtime: process.env.OPENCHAMBER_RUNTIME || 'web',
    });

    return {
      url,
      pid: child.pid || null,
      async close() {
        await closeManagedOpenCodeChild(child);
      },
    };
  };

  const resolveManagedOpenCodePort = async (requestedPort, hostname = '127.0.0.1') => {
    if (typeof requestedPort === 'number' && Number.isFinite(requestedPort) && requestedPort > 0) {
      return requestedPort;
    }

    return await new Promise((resolve, reject) => {
      const server = net.createServer();
      const cleanup = () => {
        server.removeAllListeners('error');
        server.removeAllListeners('listening');
      };

      server.once('error', (error) => {
        cleanup();
        reject(error);
      });

      server.once('listening', () => {
        const address = server.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        server.close(() => {
          cleanup();
          if (port > 0) {
            resolve(port);
            return;
          }
          reject(new Error('Failed to allocate OpenCode port'));
        });
      });

      server.listen(0, hostname);
    });
  };

  // Official v2 only publishes GET /api/experimental/migration/v1. Backfill
  // runs inside opencode2; we poll status and never POST.
  const probeV1MigrationGate = async (signal) => fetchV1MigrationGate({
    url: buildOpenCodeUrl(OPENCODE_V1_MIGRATION_PATH, ''),
    headers: getOpenCodeAuthHeaders(),
    signal,
  });

  // Health ok is not enough to pull session messages. required/running/error
  // keep isOpenCodeReady false so the proxy ready gate still blocks transcript.
  const applyV1MigrationGate = (gate) => {
    state.v1Migration = gate;
    if (gate.admitTranscript) {
      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;
      return true;
    }
    state.isOpenCodeReady = false;
    if (!state.openCodeNotReadySince) {
      state.openCodeNotReadySince = Date.now();
    }
    if (gate.phase === 'error' && gate.error) {
      state.lastOpenCodeError = gate.error;
    }
    return false;
  };

  // v2 readiness lives at /api/info (ServerInfo.version); /global/health remains
  // a probe fallback for older sidecars. Both require Basic auth from
  // getOpenCodeAuthHeaders(). Version admission rejects 1.x / missing / noise.
  // Health ok is reachability only — execution semantics live on runtimeContract.
  const fetchOpenCodeHealthResult = async (urlForPath, signal, options = {}) => {
    const headerCandidates = [
      { Accept: 'application/json', ...getOpenCodeAuthHeaders(), authenticated: true },
    ];
    if (options.allowUnauthenticated) {
      headerCandidates.push({ Accept: 'application/json', authenticated: false });
    }
    let sawUnauthorized = false;
    let lastGate = null;
    for (const headerCandidate of headerCandidates) {
      const { authenticated, ...headers } = headerCandidate;
      for (const healthPath of [OPENCODE_HEALTH_PATH, OPENCODE_HEALTH_FALLBACK_PATH]) {
        try {
          const response = await fetch(urlForPath(healthPath), {
            method: 'GET',
            headers,
            signal,
          });
          if (response.status === 401 || response.status === 403) {
            sawUnauthorized = true;
            continue;
          }
          if (!response.ok) continue;
          const body = await response.json().catch(() => null);
          const gate = evaluateOpenCodeHealthBody(body);
          lastGate = gate;
          if (gate.ok) {
            return {
              ok: true,
              version: gate.version,
              authenticated: authenticated !== false,
              healthOk: true,
            };
          }
        } catch {
        }
      }
    }
    if (sawUnauthorized && !lastGate?.ok) {
      return { ok: false, version: null, authenticated: false, healthOk: false, reason: 'auth-failed' };
    }
    return {
      ok: false,
      version: lastGate?.version ?? null,
      authenticated: sawUnauthorized ? false : null,
      healthOk: false,
      reason: lastGate?.reason || 'unhealthy',
    };
  };

  const fetchOpenCodeHealthOk = async (urlForPath, signal, options = {}) => {
    const result = await fetchOpenCodeHealthResult(urlForPath, signal, options);
    return result.ok === true;
  };

  /**
   * Invalidate any prior execution permit. Start / restart / target changes must
   * bump generation so in-flight async health probes cannot publish for a newer
   * instance, and Host/proxy gates stop holding a stale `executionAllowed: true`.
   * @param {string} [reason]
   */
  const revokeRuntimeExecutionPermit = (reason = 'instance-revoked') => {
    const nextGeneration = (Number(state.runtimeContractGeneration) || 0) + 1;
    state.runtimeContractGeneration = nextGeneration;
    state.openCodeServeVersion = null;
    state.openCodeCliVersion = null;
    state.runtimeContract = createRevokedRuntimeContract(reason, {
      instanceGeneration: nextGeneration,
    });
    return nextGeneration;
  };

  /**
   * Publish contract only for the generation that started the probe.
   * @param {object | null | undefined} probe
   * @param {object | null | undefined} migrationGate
   * @param {number | null | undefined} expectedGeneration
   */
  const refreshRuntimeContractFromProbe = (
    probe,
    migrationGate = state.v1Migration,
    expectedGeneration = state.runtimeContractGeneration,
  ) => {
    const currentGeneration = Number(state.runtimeContractGeneration) || 0;
    if (
      expectedGeneration != null
      && Number(expectedGeneration) !== currentGeneration
    ) {
      // Stale async health / migration result for a superseded instance.
      return state.runtimeContract;
    }
    const binaryPath = typeof process.env.OPENCODE_BINARY === 'string'
      ? process.env.OPENCODE_BINARY.trim()
      : '';
    const cliVersion = binaryPath ? (readOpenCode2BinaryVersion(binaryPath) || null) : null;
    const contract = evaluateRuntimeContract({
      serveVersion: probe?.version ?? null,
      cliVersion,
      reachable: probe?.ok === true || Boolean(state.openCodePort),
      authenticated: probe?.authenticated ?? null,
      healthOk: probe?.healthOk ?? probe?.ok ?? null,
      migrationAdmitTranscript: migrationGate?.admitTranscript ?? null,
      migrationPhase: migrationGate?.phase ?? null,
      migrationError: migrationGate?.error ?? null,
    });
    contract.instanceGeneration = currentGeneration;
    state.openCodeServeVersion = contract.serveVersion;
    state.openCodeCliVersion = contract.cliVersion;
    state.runtimeContract = contract;
    return contract;
  };

  const isOpenCodeProcessHealthy = async () => {
    if ((!state.openCodeProcess && !sharedServiceAttached) || !state.openCodePort) {
      return false;
    }

    const generationAtStart = Number(state.runtimeContractGeneration) || 0;
    try {
      const result = await fetchOpenCodeHealthResult(
        (healthPath) => buildOpenCodeUrl(healthPath, ''),
        AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS)
      );
      if (result.ok) {
        refreshRuntimeContractFromProbe(result, state.v1Migration, generationAtStart);
      }
      return result.ok;
    } catch {
      return false;
    }
  };

  const probeExternalOpenCode = async (port, origin) => {
    if (!port || port <= 0) {
      return false;
    }

    const generationAtStart = Number(state.runtimeContractGeneration) || 0;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const base = origin ?? `http://127.0.0.1:${port}`;
      const result = await fetchOpenCodeHealthResult(
        (healthPath) => `${base}${healthPath}`,
        controller.signal,
        { allowUnauthenticated: true },
      );
      clearTimeout(timeout);
      if (result.ok) {
        refreshRuntimeContractFromProbe(result, state.v1Migration, generationAtStart);
      }
      return result.ok;
    } catch {
      return false;
    }
  };

  const waitForOpenCodePort = async (timeoutMs = 15000) => {
    if (state.openCodePort !== null) {
      return state.openCodePort;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (state.openCodePort !== null) {
        return state.openCodePort;
      }
    }

    throw new Error('Timed out waiting for OpenCode port');
  };

  /**
   * Ensure the official service is running and point this runtime at its
   * registration (origin, port, password). Throws when the CLI cannot start it
   * or the registration is missing/malformed; the caller decides rollback.
   */
  const connectSharedOpenCodeService = async ({ binaryPath } = {}) => {
    if (!binaryPath) {
      await applyOpencodeBinaryFromSettings({ strict: true });
      if (typeof ensurePinnedOpenCode2CliEnv === 'function') {
        await ensurePinnedOpenCode2CliEnv();
      }
      ensureOpencodeCliEnv();
    }
    let binary = binaryPath || (process.env.OPENCODE_BINARY || 'opencode').trim() || 'opencode';
    let args = [];
    if (process.platform === 'win32') {
      const launchSpec = resolveManagedOpenCodeLaunchSpec(binary);
      if (launchSpec?.binary) {
        binary = launchSpec.binary;
        args = Array.isArray(launchSpec.args) ? launchSpec.args : [];
      }
    }
    const envPath = typeof buildManagedOpenCodePath === 'function'
      ? buildManagedOpenCodePath()
      : typeof buildAugmentedPath === 'function'
        ? buildAugmentedPath()
        : process.env.PATH;
    const shellEnv = typeof getManagedOpenCodeShellEnvSnapshot === 'function'
      ? getManagedOpenCodeShellEnvSnapshot() || {}
      : {};
    await sharedService.start({
      binary,
      args,
      replace: Boolean(binaryPath),
      env: sharedService.buildStartEnv({ ...shellEnv, ...process.env, PATH: envPath }),
    });
    const registration = await sharedService.readRegistration();
    if (!registration) {
      throw new Error(`OpenCode service started but ${sharedService.registrationFile} is missing or invalid`);
    }
    adoptOpenCodeServerPassword?.(registration.password, 'shared-service');
    state.openCodeBaseUrl = registration.origin;
    setOpenCodePort(registration.port);
    sharedServicePid = registration.pid;
    return registration;
  };

  /**
   * Attach to the shared official service instead of spawning a private serve.
   * Failure leaves integration unavailable and retryable, never silently
   * starting a private server with different lifecycle semantics.
   */
  const attachSharedOpenCodeService = async () => {
    if (!sharedService) return false;
    revokeRuntimeExecutionPermit('shared-service-attach');
    state.isOpenCodeReady = false;
    state.openCodeNotReadySince = Date.now();
    try {
      const registration = await connectSharedOpenCodeService();
      if (!(await probeExternalOpenCode(registration.port, registration.origin))) {
        throw new Error(`OpenCode service at ${registration.origin} did not pass the health/version check`);
      }
      if (state.openCodeProcess && !state.isExternalOpenCode) {
        await state.openCodeProcess.close();
        state.openCodeProcess = null;
      }
      sharedServiceAttached = true;
      state.isExternalOpenCode = true;
      state.lastOpenCodeError = null;
      state.v1Migration = null;
      state.managedCapabilityIdentity = null;
      managedCapabilitiesRuntime?.setCapabilityIdentity(null);
      syncToHmrState();
      console.log(`[OpenCode] Attached to shared OpenCode service at ${registration.origin} (v${registration.version ?? 'unknown'})`);
      return true;
    } catch (error) {
      sharedServiceAttached = false;
      sharedServicePid = null;
      state.openCodeBaseUrl = null;
      state.openCodePort = null;
      adoptOpenCodeServerPassword?.(null, null);
      syncToHmrState();
      throw error;
    }
  };

  // `location.reload` rebuilds every loaded location in place: running
  // sessions continue at the next step boundary and clients get
  // `location.shutdown` to refetch location services.
  const reloadSharedOpenCodeLocations = async () => {
    const response = await fetch(buildOpenCodeUrl('/api/location/reload', ''), {
      method: 'POST',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenCode location reload failed (HTTP ${response.status})${body ? `: ${body.slice(0, 300)}` : ''}`);
    }
  };

  const START_OPEN_CODE_MAX_ATTEMPTS = 2;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const startOpenCodeOnce = async () => {
    // New managed instance — drop any prior permit before spawn/probes.
    const generationAtStart = revokeRuntimeExecutionPermit('managed-start');
    const requestedPort = env.ENV_CONFIGURED_OPENCODE_PORT;
    const defaultPortFree = requestedPort
      ? false
      : await waitForPortRelease(DEFAULT_OPENCODE_SERVE_PORT, 200, env.ENV_CONFIGURED_OPENCODE_HOSTNAME);
    const desiredPort = requestedPort
      ?? (defaultPortFree ? DEFAULT_OPENCODE_SERVE_PORT : 0);
    const spawnPort = await resolveManagedOpenCodePort(desiredPort, env.ENV_CONFIGURED_OPENCODE_HOSTNAME);
    console.log(
      desiredPort > 0
        ? `Starting OpenCode on requested port ${desiredPort}...`
        : `Starting OpenCode on allocated port ${spawnPort}...`
    );

    await applyOpencodeBinaryFromSettings({ strict: true });
    if (typeof ensurePinnedOpenCode2CliEnv === 'function') {
      await ensurePinnedOpenCode2CliEnv();
    }
    ensureOpencodeCliEnv();
    const openCodePassword = await ensureLocalOpenCodeServerPassword({ rotateManaged: true });
    const envPath = typeof buildManagedOpenCodePath === 'function'
      ? buildManagedOpenCodePath()
      : typeof buildAugmentedPath === 'function'
        ? buildAugmentedPath()
      : process.env.PATH;
    const shellEnv = typeof getManagedOpenCodeShellEnvSnapshot === 'function'
      ? getManagedOpenCodeShellEnvSnapshot() || {}
      : {};

    try {
      const childEnv = {
        ...shellEnv,
        ...process.env,
        PATH: envPath,
        OPENCODE_SERVER_PASSWORD: openCodePassword,
      };
      const managedEnv = managedCapabilitiesRuntime
        ? await managedCapabilitiesRuntime.prepareManagedChildEnv(childEnv)
        : childEnv;
      const serverInstance = await createManagedOpenCodeServerProcess({
        hostname: env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
        port: spawnPort,
        timeout: 30000,
        cwd: state.openCodeWorkingDirectory,
        shellEnvKeysCount: Object.keys(shellEnv).length,
        env: managedEnv,
      });

      if (!serverInstance || !serverInstance.url) {
        throw new Error('OpenCode server started but URL is missing');
      }

      const url = new URL(serverInstance.url);
      const port = parseInt(url.port, 10);
      const prefix = normalizeApiPrefix(url.pathname);

      if (await waitForReady(serverInstance.url, 10000)) {
        setOpenCodePort(port);
        setDetectedOpenCodeApiPrefix(prefix);

        // Evaluate contract for THIS generation from live health + migration.
        const healthResult = await fetchOpenCodeHealthResult(
          (healthPath) => buildOpenCodeUrl(healthPath, ''),
          AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        );
        const gate = await probeV1MigrationGate(AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS));
        refreshRuntimeContractFromProbe(healthResult, gate, generationAtStart);
        if (applyV1MigrationGate(gate)) {
          refreshRuntimeContractFromProbe(healthResult, gate, generationAtStart);
          state.lastOpenCodeError = null;
        }

        return serverInstance;
      }

      try {
        await serverInstance.close();
      } catch {
      }
      throw new Error('Server started but health check failed (timeout)');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastOpenCodeError = message;
      state.openCodePort = null;
      // Keep revoked/pending contract — do not resurrect the prior permit.
      if ((Number(state.runtimeContractGeneration) || 0) === generationAtStart) {
        refreshRuntimeContractFromProbe(
          { ok: false, version: null, authenticated: null, healthOk: false },
          state.v1Migration,
          generationAtStart,
        );
      }
      syncToHmrState();
      console.error(`Failed to start OpenCode: ${message}`);
      throw error;
    }
  };

  const startOpenCode = async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= START_OPEN_CODE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await startOpenCodeOnce();
      } catch (error) {
        lastError = error;
        if (error?.code === 'OPENCODE_BINARY_INVALID') {
          break;
        }
        if (attempt >= START_OPEN_CODE_MAX_ATTEMPTS) {
          break;
        }

        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[OpenCode] Managed server startup failed on attempt ${attempt}/${START_OPEN_CODE_MAX_ATTEMPTS}; retrying: ${message}`);
        state.openCodePort = null;
        state.isOpenCodeReady = false;
        state.openCodeNotReadySince = Date.now();
        syncToHmrState();
        await delay(750 * attempt);
      }
    }

    throw lastError;
  };

  const restartOpenCode = async (options = {}) => {
    if (state.isShuttingDown) return;
    if (state.currentRestartPromise) {
      await state.currentRestartPromise;
      if (!options.binaryPath) return;
    }

    state.currentRestartPromise = (async () => {
      state.isRestartingOpenCode = true;
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      // Drop prior instance permit before any probe / respawn.
      const restartGeneration = revokeRuntimeExecutionPermit('managed-restart');
      console.log('Restarting OpenCode process...');

      if (state.isExternalOpenCode) {
        if (sharedServiceAttached) {
          // The service may have been stopped or replaced by another client
          // (new pid, possibly new port/password); recovery only rediscovers it.
          // An explicit upgrade supplies a verified owned-cache binary.
          console.log('Re-ensuring shared OpenCode service...');
          try {
            await connectSharedOpenCodeService(options);
          } catch (error) {
            state.lastOpenCodeError = error instanceof Error ? error.message : String(error);
            syncToHmrState();
            throw error;
          }
        }
        console.log('Re-probing external OpenCode server...');
        const probePort = state.openCodePort || env.ENV_CONFIGURED_OPENCODE_PORT || 4096;
        const probeOrigin = state.openCodeBaseUrl ?? env.ENV_CONFIGURED_OPENCODE_HOST?.origin;
        const healthy = await probeExternalOpenCode(probePort, probeOrigin);
        if (healthy) {
          console.log(`External OpenCode server on port ${probePort} is healthy`);
          setOpenCodePort(probePort);
          const healthResult = await fetchOpenCodeHealthResult(
            (healthPath) => buildOpenCodeUrl(healthPath, ''),
            AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
          );
          const gate = await probeV1MigrationGate(AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS));
          refreshRuntimeContractFromProbe(healthResult, gate, restartGeneration);
          if (applyV1MigrationGate(gate)) {
            refreshRuntimeContractFromProbe(healthResult, gate, restartGeneration);
            state.lastOpenCodeError = null;
          }
          syncToHmrState();
        } else {
          state.lastOpenCodeError = `External OpenCode server on port ${probePort} is not responding`;
          state.v1Migration = null;
          console.error(state.lastOpenCodeError);
          throw new Error(state.lastOpenCodeError);
        }

        if (state.expressApp) {
          setupProxy(state.expressApp);
          ensureOpenCodeApiPrefix();
        }
        return;
      }

      const portToRelease = state.openCodePort;

      if (state.openCodeProcess) {
        console.log('Stopping existing OpenCode process...');
        try {
          // close() owns the full SIGTERM→SIGKILL escalation on this child handle.
          // Do not SIGKILL a pre-captured pid afterward — the OS may have recycled it.
          await state.openCodeProcess.close();
        } catch (error) {
          console.warn('Error closing OpenCode process:', error);
        }
        state.openCodeProcess = null;
        syncToHmrState();
      }

      // Probe only: never mass-kill whoever holds the port (clients / external serve).
      if (!(await waitForPortRelease(portToRelease, 5000))) {
        console.warn(`Timed out waiting for OpenCode port ${portToRelease} to be released`);
      }

      if (env.ENV_CONFIGURED_OPENCODE_PORT) {
        console.log(`Using OpenCode port from environment: ${env.ENV_CONFIGURED_OPENCODE_PORT}`);
        setOpenCodePort(env.ENV_CONFIGURED_OPENCODE_PORT);
      } else {
        state.openCodePort = null;
        syncToHmrState();
      }

      state.openCodeApiPrefixDetected = true;
      state.openCodeApiPrefix = '';
      if (state.openCodeApiDetectionTimer) {
        clearTimeout(state.openCodeApiDetectionTimer);
        state.openCodeApiDetectionTimer = null;
      }

      state.lastOpenCodeError = null;
      state.openCodeProcess = await startOpenCode();
      syncToHmrState();

      if (state.expressApp) {
        setupProxy(state.expressApp);
        ensureOpenCodeApiPrefix();
      }
    })();

    try {
      await state.currentRestartPromise;
    } catch (error) {
      console.error(`Failed to restart OpenCode: ${error.message}`);
      state.lastOpenCodeError = error.message;
      // External serve is read-only: never clear its port, flip ownership, or
      // spawn a managed replacement when a re-probe fails.
      if (!state.isExternalOpenCode) {
        if (!env.ENV_CONFIGURED_OPENCODE_PORT) {
          state.openCodePort = null;
          syncToHmrState();
        }
        state.openCodeApiPrefixDetected = true;
        state.openCodeApiPrefix = '';
      }
      throw error;
    } finally {
      state.currentRestartPromise = null;
      state.isRestartingOpenCode = false;
    }
  };

  const waitForOpenCodeReady = async (timeoutMs = 20000, intervalMs = 400) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    // Pin generation for this wait loop so a concurrent restart cannot have our
    // late probe overwrite the newer instance contract.
    const generationAtStart = Number(state.runtimeContractGeneration) || 0;

    while (Date.now() < deadline) {
      let timeout = null;
      try {
        if ((Number(state.runtimeContractGeneration) || 0) !== generationAtStart) {
          throw new Error('OpenCode instance changed while waiting for ready');
        }
        // One timer covers health + migration for this attempt. Clearing after
        // health alone let a hung migration outrun HEALTH_CHECK_TIMEOUT_MS and
        // the outer deadline when the probe never settled.
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
        const healthResult = await fetchOpenCodeHealthResult(
          (healthPath) => buildOpenCodeUrl(healthPath, ''),
          controller.signal
        );

        if (!healthResult.ok) {
          refreshRuntimeContractFromProbe(healthResult, state.v1Migration, generationAtStart);
          lastError = new Error(
            healthResult.reason === 'auth-failed'
              ? 'OpenCode health endpoint rejected authentication'
              : 'OpenCode health endpoint returned unhealthy response',
          );
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        const gate = await probeV1MigrationGate(controller.signal);
        refreshRuntimeContractFromProbe(healthResult, gate, generationAtStart);
        if (applyV1MigrationGate(gate)) {
          // Re-publish contract after admitTranscript flips ready.
          refreshRuntimeContractFromProbe(healthResult, gate, generationAtStart);
          state.lastOpenCodeError = null;
          return;
        }

        lastError = new Error(gate.error || `V1 migration is ${gate.phase}`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      } catch (error) {
        lastError = error;
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    if (lastError) {
      state.lastOpenCodeError = lastError.message || String(lastError);
      throw lastError;
    }

    const timeoutError = new Error('Timed out waiting for OpenCode to become ready');
    state.lastOpenCodeError = timeoutError.message;
    throw timeoutError;
  };

  const waitForAgentPresence = async (agentName, timeoutMs = 15000, intervalMs = 300) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(buildOpenCodeUrl('/agent'), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        });

        if (response.ok) {
          const agents = await response.json();
          if (Array.isArray(agents) && agents.some((agent) => agent?.name === agentName)) {
            return;
          }
        }
      } catch {
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Agent "${agentName}" not available after OpenCode restart`);
  };

  const refreshOpenCodeAfterConfigChange = async (reason, options = {}) => {
    const { agentName } = options;

    console.log(`Refreshing OpenCode after ${reason}`);

    if (sharedServiceAttached) {
      // Shared with other clients: reload in place instead of restarting.
      await reloadSharedOpenCodeLocations();
      if (agentName) {
        await waitForAgentPresence(agentName);
      }
      return { reloaded: true, external: true };
    }

    clearResolvedOpenCodeBinary();
    await applyOpencodeBinaryFromSettings();

    await restartOpenCode();

    // A managed OpenCode process is restarted (and thus re-reads config from
    // disk) by restartOpenCode(). An external OpenCode server is NOT owned by
    // OpenChamber: restartOpenCode() only re-probes its health, so the freshly
    // written config is on disk but the running server keeps serving its old,
    // startup-cached config until the user restarts it themselves. Report this
    // honestly so callers don't claim the change is live.
    const external = state.isExternalOpenCode === true;

    try {
      await waitForOpenCodeReady();
      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;

      // Waiting for the agent to appear only makes sense when we actually
      // reloaded config. An external server will never surface it here.
      if (agentName && !external) {
        await waitForAgentPresence(agentName);
      }

      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;
    } catch (error) {
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.error(`Failed to refresh OpenCode after ${reason}:`, error.message);
      throw error;
    }

    return { reloaded: !external, external };
  };

  let bootstrapOpenCodePromise = null;
  let retryOpenCodePromise = null;

  const runBootstrapOpenCodeAtStartup = async () => {
    try {
      // Before doing anything, reap any OpenCode process WE spawned in a prior
      // run that was orphaned by a crash/hard-exit. Verified + scoped to our own
      // pids, so it never touches a live instance's or the user's own server.
      try {
        const { reaped } = await reapOrphanedProcesses({ log: (msg) => console.log(msg) });
        if (reaped > 0) console.log(`[lifecycle] startup reaped ${reaped} orphaned OpenCode process(es)`);
      } catch (error) {
        console.warn('[lifecycle] orphan reap failed:', error?.message ?? error);
      }

      syncFromHmrState();
      if (managedCapabilitiesRuntime && state.managedCapabilityIdentity) {
        managedCapabilitiesRuntime.setCapabilityIdentity(state.managedCapabilityIdentity);
      }
      if (env.ENV_SKIP_OPENCODE_START && env.ENV_EFFECTIVE_PORT) {
        if (state.openCodeProcess && !state.isExternalOpenCode) {
          await state.openCodeProcess.close();
          state.openCodeProcess = null;
          state.openCodePort = null;
        }
        state.managedCapabilityIdentity = null;
        managedCapabilitiesRuntime?.setCapabilityIdentity(null);
        const label = env.ENV_CONFIGURED_OPENCODE_HOST ? env.ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
        console.log(`Using external OpenCode server at ${label} (skip-start mode)`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        // External attach is not ready until version + V1 migration admit.
        revokeRuntimeExecutionPermit('external-attach');
        state.isOpenCodeReady = false;
        state.openCodeNotReadySince = Date.now();
        state.isExternalOpenCode = true;
        state.lastOpenCodeError = null;
        state.v1Migration = null;
        syncToHmrState();
      } else if (
        sharedService
        && !env.ENV_CONFIGURED_OPENCODE_PORT
        && !env.ENV_CONFIGURED_OPENCODE_HOST
      ) {
        await attachSharedOpenCodeService();
      } else if (await isOpenCodeProcessHealthy() && (managedCapabilitiesRuntime ? managedCapabilitiesRuntime.hasValidIdentity() : true)) {
        console.log(`[HMR] Reusing existing OpenCode process on port ${state.openCodePort}`);
      } else if (state.openCodeProcess && !state.isExternalOpenCode && await isOpenCodeProcessHealthy()) {
        console.log('[HMR] Restarting managed OpenCode because scheduled-task capability identity is stale');
        await restartOpenCode();
      } else if (
        (env.ENV_EFFECTIVE_PORT || DEFAULT_OPENCODE_SERVE_PORT)
        && await probeExternalOpenCode(
          env.ENV_EFFECTIVE_PORT || DEFAULT_OPENCODE_SERVE_PORT,
          env.ENV_CONFIGURED_OPENCODE_HOST?.origin,
        )
      ) {
        const reusePort = env.ENV_EFFECTIVE_PORT || DEFAULT_OPENCODE_SERVE_PORT;
        const label = env.ENV_CONFIGURED_OPENCODE_HOST ? env.ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${reusePort}`;
        console.log(`Reusing existing OpenCode serve at ${label}`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        setOpenCodePort(reusePort);
        // Health ok is not transcript-ready; waitForOpenCodeReady applies the gate.
        state.isOpenCodeReady = false;
        state.openCodeNotReadySince = Date.now();
        state.isExternalOpenCode = true;
        state.lastOpenCodeError = null;
        state.v1Migration = null;
        syncToHmrState();
      } else {
        // No healthy v2 serve on the requested/default port. Start a generic
        // `opencode serve` so OpenChamber and other OpenCode clients can share it.
        state.isExternalOpenCode = false;
        state.openCodeBaseUrl = null;
        if (env.ENV_EFFECTIVE_PORT) {
          console.log(`Using OpenCode port from environment: ${env.ENV_EFFECTIVE_PORT}`);
          setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        } else {
          state.openCodePort = null;
          syncToHmrState();
        }

        state.lastOpenCodeError = null;
        state.openCodeProcess = await startOpenCode();
        syncToHmrState();
      }
      await waitForOpenCodePort();
      try {
        await waitForOpenCodeReady();
        // Warm only after readiness admits; a failed gate must not kick off
        // directory-scoped traffic against an unready upstream.
        if (state.isOpenCodeReady) {
          void warmOpenCodeDirectories();
        }
      } catch (error) {
        console.error(`OpenCode readiness check failed: ${error.message}`);
      }
    } catch (error) {
      console.error(`Failed to start OpenCode: ${error.message}`);
      console.log('Continuing without OpenCode integration...');
      state.lastOpenCodeError = error.message;
    }
  };

  // OpenCode initializes each project directory lazily on its first
  // directory-scoped request, and that initialization takes seconds on large
  // session stores. Without warming, the user's first session open pays it
  // interactively. Warm the most recently used directories right after
  // readiness so the work overlaps UI startup instead. Sequential and
  // best-effort: a failed or slow directory never blocks the others for long,
  // and a restart invalidates the pass via the port/readiness guard.
  const warmOpenCodeDirectories = async () => {
    let directories = [];
    try {
      directories = await getWarmupDirectories();
    } catch {
      return;
    }
    if (!Array.isArray(directories) || directories.length === 0) return;

    const warmedPort = state.openCodePort;
    for (const directory of directories.slice(0, WARMUP_DIRECTORY_LIMIT)) {
      if (typeof directory !== 'string' || !directory) continue;
      if (!state.isOpenCodeReady || state.openCodePort !== warmedPort) return;
      let timeout = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), WARMUP_REQUEST_TIMEOUT_MS);
        // Warming a directory is the point, not the answer: any directory-scoped
        // read makes OpenCode initialise it. `/api/session` is the cheapest one
        // that takes a directory.
        const url = `${buildOpenCodeUrl('/api/session', '')}?directory=${encodeURIComponent(directory)}&limit=1`;
        await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          signal: controller.signal,
        });
      } catch {
        // Best-effort — the directory stays lazy and the UI's own request warms it.
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  };

  const bootstrapOpenCodeAtStartup = () => {
    if (!bootstrapOpenCodePromise) {
      bootstrapOpenCodePromise = runBootstrapOpenCodeAtStartup().finally(() => {
        bootstrapOpenCodePromise = null;
      });
    }
    return bootstrapOpenCodePromise;
  };

  const retryOpenCodeStartup = () => {
    if (!retryOpenCodePromise) {
      retryOpenCodePromise = (async () => {
        if (bootstrapOpenCodePromise) {
          await bootstrapOpenCodePromise;
        }
        if (state.isOpenCodeReady) return;

        clearResolvedOpenCodeBinary();
        await applyOpencodeBinaryFromSettings({ strict: true });
        if (typeof ensurePinnedOpenCode2CliEnv === 'function') {
          await ensurePinnedOpenCode2CliEnv();
        }
        const resolved = ensureOpencodeCliEnv();
        if (!resolved) {
          const error = new Error('OpenCode CLI could not be resolved');
          state.lastOpenCodeError = error.message;
          state.openCodeNotReadySince = Date.now();
          throw error;
        }

        await bootstrapOpenCodeAtStartup();
        if (!state.isOpenCodeReady) {
          throw new Error(state.lastOpenCodeError || 'OpenCode failed to become ready');
        }
      })().finally(() => {
        retryOpenCodePromise = null;
      });
    }
    return retryOpenCodePromise;
  };

  /**
   * Perform an immediate (one-shot) health check and restart OpenCode if it's
   * not healthy.  Callers on the SSE / WS proxy path use this to trigger
   * recovery without waiting for the next periodic interval (up to 15 s).
   *
   * Skips restart when sessions are actively busy — a busy server under
   * concurrent load can fail the health check timeout without actually
   * being dead (the health endpoint competes with LLM work).
   * Forces restart if sessions stay "busy" and the server stays unhealthy
   * for over 2 minutes (staleness guard against stuck session state).
   */
  const STALE_BUSY_GRACE_MS = 2 * 60 * 1000;
  let lastUnhealthyWithBusySessionsAt = 0;
  let consecutiveHealthFailures = 0;
  let healthProbePromise = null;
  let healthCheckCyclePromise = null;
  let lastHealthProbeResult = null;

  const resetHealthFailureState = () => {
    consecutiveHealthFailures = 0;
    lastUnhealthyWithBusySessionsAt = 0;
  };

  const probeOpenCodeHealth = async () => {
    const now = Date.now();
    if (lastHealthProbeResult && now - lastHealthProbeResult.at < HEALTH_CHECK_RESULT_CACHE_MS) {
      return lastHealthProbeResult.healthy;
    }

    if (healthProbePromise) {
      return healthProbePromise;
    }

    healthProbePromise = isOpenCodeProcessHealthy()
      .then((healthy) => {
        lastHealthProbeResult = { at: Date.now(), healthy };
        return healthy;
      })
      .finally(() => {
        healthProbePromise = null;
      });

    return healthProbePromise;
  };

  const shouldSkipRestartForBusySessions = () => {
    const activeCount = getActiveSessionCount();
    if (activeCount === 0) {
      lastUnhealthyWithBusySessionsAt = 0;
      return false;
    }

    const now = Date.now();
    if (!lastUnhealthyWithBusySessionsAt) {
      lastUnhealthyWithBusySessionsAt = now;
      return true;
    }

    if (now - lastUnhealthyWithBusySessionsAt >= STALE_BUSY_GRACE_MS) {
      console.warn(
        `[lifecycle] OpenCode unhealthy with ${activeCount} busy session(s) for > 2 min — forcing restart`
      );
      lastUnhealthyWithBusySessionsAt = 0;
      return false;
    }

    return true;
  };

  const runHealthCheckCycle = async (source) => {
    // External serve is read-only mount: never restart or spawn a second copy
    // because the user's instance looks unhealthy from our probe. The shared
    // service is the exception: "restart" only re-runs `service start`.
    if (state.isExternalOpenCode && !sharedServiceAttached) return;
    if (!sharedServiceAttached && !state.openCodeProcess) return;
    if (state.isShuttingDown || state.isRestartingOpenCode) return;
    if (healthCheckCyclePromise) return healthCheckCyclePromise;

    healthCheckCyclePromise = (async () => {
      const healthy = await probeOpenCodeHealth();
      if (!healthy) {
        const processAlive = sharedServiceAttached
          ? isProcessAlive(sharedServicePid)
          : isManagedOpenCodeProcessAlive();
        if (!processAlive) {
          console.log(`[lifecycle] ${source} health check: OpenCode process exited, restarting...`);
          consecutiveHealthFailures = 0;
          lastHealthProbeResult = null;
          await restartOpenCode();
          return;
        }
        consecutiveHealthFailures += 1;
        console.warn(
          `[lifecycle] ${source} health check failed (${consecutiveHealthFailures}/${HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES})`
        );
        if (consecutiveHealthFailures < HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES) return;
        if (shouldSkipRestartForBusySessions()) return;
        console.log(`[lifecycle] ${source} health check failure threshold reached, restarting OpenCode...`);
        consecutiveHealthFailures = 0;
        lastHealthProbeResult = null;
        await restartOpenCode();
      } else {
        resetHealthFailureState();
        try {
          const gate = await probeV1MigrationGate(AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS));
          applyV1MigrationGate(gate);
        } catch {
        }
      }
    })().finally(() => {
      healthCheckCyclePromise = null;
    });

    return healthCheckCyclePromise;
  };

  const triggerHealthCheck = async () => {
    try {
      await runHealthCheckCycle('immediate');
    } catch (error) {
      console.error(`[lifecycle] immediate health check error: ${error.message}`);
    }
  };

  const startHealthMonitoring = (healthCheckIntervalMs) => {
    if (state.healthCheckInterval) {
      clearInterval(state.healthCheckInterval);
    }

    const effectiveIntervalMs = HEALTH_CHECK_INTERVAL_OVERRIDE_MS || healthCheckIntervalMs;

    state.healthCheckInterval = setInterval(async () => {
      try {
        await runHealthCheckCycle('periodic');
      } catch (error) {
        console.error(`Health check error: ${error.message}`);
      }
    }, effectiveIntervalMs);
  };

  return {
    killProcessOnPort,
    isSharedOpenCodeService: () => sharedServiceAttached,
    startOpenCode,
    restartOpenCode,
    waitForOpenCodeReady,
    waitForAgentPresence,
    refreshOpenCodeAfterConfigChange,
    bootstrapOpenCodeAtStartup,
    retryOpenCodeStartup,
    startHealthMonitoring,
    triggerHealthCheck,
    waitForPortRelease,
    revokeRuntimeExecutionPermit,
    refreshRuntimeContractFromProbe,
  };
};
