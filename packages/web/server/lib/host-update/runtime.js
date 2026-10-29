import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compareVersions, releaseParts } from './releases.js';

const ACTIVE = new Set(['checking', 'downloading', 'installing', 'restarting']);
const CHANNELS = new Set(['stable', 'beta']);
const failure = (status, code) => Object.assign(new Error(code), { status, code });

export async function writeUpdateState(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}

/** One Host-owned plan/operation authority shared by direct and Relay callers. */
export function createHostUpdateRuntime({ adapter, stateFile, getServerId, currentVersion, now = Date.now }) {
  let state = { channel: null, operation: null };
  let initialized;
  let queue = Promise.resolve();
  const plans = new Map();
  const serial = (work) => {
    const pending = queue.then(work, work);
    queue = pending.catch(() => {});
    return pending;
  };
  const version = () => typeof currentVersion === 'function' ? currentVersion() : currentVersion;
  const statePath = () => typeof stateFile === 'function' ? stateFile() : stateFile;
  const persist = () => writeUpdateState(statePath(), state);
  const initialize = () => initialized ??= (async () => {
    try {
      const saved = JSON.parse(await readFile(statePath(), 'utf8'));
      if (!saved || ![null, 'stable', 'beta'].includes(saved.channel) || (saved.operation && typeof saved.operation.id !== 'string')) throw new Error('Invalid update state');
      state = saved;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state.operation && ACTIVE.has(state.operation.status)) {
      // A detached CLI worker remains authoritative while installing; only a
      // restarting operation can be verified by the newly running Host.
      if (state.operation.status === 'restarting') {
        const sameHost = !state.operation.serverId || state.operation.serverId === await getServerId();
        state.operation.status = sameHost && state.operation.version === version() ? 'succeeded' : 'failed';
        state.operation.error = state.operation.status === 'failed' ? 'version_mismatch_after_restart' : null;
        state.operation.updatedAt = now();
        await persist();
      } else {
        state.operation.status = 'failed';
        state.operation.error = 'update_interrupted';
        await persist();
      }
    }
  })();
  const ownBusy = () => Boolean(state.operation && ACTIVE.has(state.operation.status));
  const busy = () => ownBusy() || Boolean(adapter.operation?.() && ACTIVE.has(adapter.operation().status));
  const effectiveChannel = () => adapter.channel?.() ?? state.channel ?? (version().includes('-') ? 'beta' : 'stable');
  const readState = async () => {
    await initialize();
    // The CLI helper owns state after handoff, including failures while offline.
    if (adapter.external && ownBusy()) {
      const saved = JSON.parse(await readFile(statePath(), 'utf8'));
      if (saved.operation?.id === state.operation.id) state = saved;
    }
  };
  const fingerprint = (release, channel, serverId) => createHash('sha256').update(JSON.stringify({
    release: release && { version: release.version, kind: release.kind, rollback: release.rollback, integrity: release.integrity, artifact: release.artifact },
    channel, serverId, currentVersion: version(), host: adapter.host, platform: process.platform, arch: process.arch,
  })).digest('hex');
  const snapshot = async (channel, update = null, checkError = null) => ({
    serverId: await getServerId(), host: adapter.host, currentVersion: version(), channel,
    supported: adapter.supported !== false, reason: adapter.reason ?? null,
    available: checkError || busy() ? null : Boolean(update),
    update, operation: ownBusy() ? state.operation : adapter.operation?.() ?? state.operation, checkError,
  });
  const inspect = async (requestedChannel) => {
    await readState();
    const channel = requestedChannel ?? effectiveChannel();
    if (!CHANNELS.has(channel)) throw failure(400, 'invalid_update_channel');
    if (busy()) return snapshot(channel);
    await adapter.refreshSupport?.();
    if (adapter.supported === false) return snapshot(channel);
    const cached = plans.get(channel);
    if (cached && cached.checkedAt + 60_000 > now()) return snapshot(channel, {
      ...cached.release, integrity: undefined, artifact: undefined, planId: cached.id, expiresAt: cached.expiresAt,
    });
    const release = await adapter.inspect(channel);
    if (!release) return snapshot(channel);
    if (!releaseParts(release.version) || (channel === 'stable' && release.version.includes('-'))) throw failure(502, 'invalid_update_release');
    const serverId = await getServerId();
    const key = fingerprint(release, channel, serverId);
    let plan = plans.get(channel);
    if (!plan || plan.key !== key || plan.expiresAt <= now()) {
      plan = { id: randomUUID(), key, release, channel, checkedAt: now(), expiresAt: now() + 10 * 60_000 };
      plans.set(channel, plan);
    }
    return snapshot(channel, { ...release, integrity: undefined, artifact: undefined, planId: plan.id, expiresAt: plan.expiresAt });
  };
  const get = (channel) => serial(async () => {
    try { return await inspect(channel); }
    catch (error) {
      if (error.status === 400) throw error;
      // Keep task state observable even when release discovery is unavailable.
      return { ...await snapshot(channel ?? effectiveChannel(), null, 'update_check_failed'), checkFailed: true };
    }
  });
  const start = (request) => serial(async () => {
    await readState();
    if (!request || !releaseParts(request.version) || !CHANNELS.has(request.channel) || typeof request.planId !== 'string') throw failure(400, 'invalid_update_request');
    const previous = state.operation;
    if (previous?.version === request.version && previous.channel === request.channel && previous.planId === request.planId && previous.status !== 'failed') return previous;
    if (busy()) throw failure(409, 'update_in_progress');
    if (adapter.supported === false) throw failure(501, 'host_update_unsupported');
    const plan = plans.get(request.channel);
    if (!plan || plan.id !== request.planId || plan.expiresAt <= now() || plan.release.version !== request.version) throw failure(409, 'update_plan_expired');
    const release = await adapter.inspect(request.channel);
    const serverId = await getServerId();
    if (!release || fingerprint(release, request.channel, serverId) !== plan.key) throw failure(409, 'update_plan_changed');
    if (compareVersions(release.version, version()) < 0 && !(release.rollback && request.channel === 'stable' && version().includes('-') && request.allowDowngrade === true)) throw failure(409, 'update_downgrade_requires_confirmation');
    await adapter.assertReady?.();
    const saved = state;
    state = { channel: request.channel, operation: {
      id: randomUUID(), planId: plan.id, serverId, version: request.version, channel: request.channel,
      kind: release.kind, status: 'checking', progress: null, error: null, updatedAt: now(),
    } };
    try { await persist(); } catch (error) { state = saved; throw error; }
    const operation = { ...state.operation };
    // Do not shut down before the accepted HTTP response has flushed.
    setTimeout(() => {
      const report = async (patch) => {
        Object.assign(state.operation, patch, { updatedAt: now() });
        await persist();
      };
      void Promise.resolve().then(() => adapter.execute({ release, channel: request.channel, stateFile: statePath(), state: structuredClone(state), report }))
        .catch(() => report({ status: 'failed', error: 'update_execution_failed' })).catch(() => {});
    }, 500);
    return operation;
  });
  return { get, start, isBusy: busy, progress(percent) {
    if (state.operation?.status === 'downloading' && Number.isFinite(percent)) state.operation.progress = Math.max(0, Math.min(100, percent));
  } };
}
