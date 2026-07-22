import { validAssistantDeliveryParts } from '../assistant-delivery-parts.js';

const DEFAULT_LEASE_MS = 15_000;
const ELIGIBILITY_TIMEOUT_MS = 10_000;
const RECONCILE_TIMEOUT_MS = 10_000;
const retryDelay = (attempts) => Math.min(60_000, 2_000 * 2 ** Math.max(0, attempts - 1));
const statusOf = (result) => result?.status ?? result?.response?.status;
const leaseArgs = (claim, runtimeKey) => ({ queueItemID: claim.item.queueItemID, leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration, runtimeKey });
const settle = (value) => Promise.resolve(value);

export const createMessageQueueWorker = ({ service, adapter, workerID, concurrency = 4, leaseMs = DEFAULT_LEASE_MS, clock = () => Date.now() } = {}) => {
  if (!service || !adapter || typeof workerID !== 'string' || !workerID) throw new TypeError('message_queue_worker_dependencies_required');
  let paused = true; let stopping = false; let timer; let flight = null; let safeFlight = null; let wakeRequested = false; const active = new Set(); const controllers = new Set();
  const process = async (claim, eligibility, runtimeKey, runtime) => {
    const { item } = claim; const args = leaseArgs(claim, runtimeKey); let begun = false; let leaseLost = false; const controller = new AbortController(); controllers.add(controller);
    const renew = () => { try { settle(service.renewLease({ ...args, leaseMs })).catch((error) => { if (error?.code === 'lease_lost') { leaseLost = true; controller.abort(); } }); } catch (error) { if (error?.code === 'lease_lost') { leaseLost = true; controller.abort(); } } };
    const heartbeat = setInterval(renew, Math.max(1, Math.floor(leaseMs / 3)));
    try {
      const assistantDelivery = item.deliveryTarget?.kind === 'assistant';
      if (assistantDelivery && (!item.deliveryTarget.assistantID || !item.deliveryConfig || !validAssistantDeliveryParts(item.deliveryParts, { allowAttachmentRefs: true }))) return settle(service.markFailed({ ...args, errorCode: 'malformed_target' }));
      const messageID = adapter.createMessageID(eligibility.latestMessageID);
      const preflight = { ...item, messageID, scope: { scopeID: item.scopeID, directory: item.directory, sessionID: item.sessionID }, runtime, runtimeKey };
      await settle(adapter.waitForReady?.({ signal: controller.signal }));
      if (leaseLost) return;
      if (paused || stopping || controller.signal.aborted) return settle(service.releaseIneligible({ ...args, dueAt: clock() + 1_000 }));
      const deliveryPayload = preflight;
      const parts = assistantDelivery
        ? await settle(adapter.materializeAssistantDeliveryParts ? adapter.materializeAssistantDeliveryParts(preflight, { signal: controller.signal }) : item.deliveryParts)
        : await settle(adapter.materializeAttachments(deliveryPayload, { signal: controller.signal }));
      if (assistantDelivery && !validAssistantDeliveryParts(parts)) return settle(service.markFailed({ ...args, errorCode: 'malformed_target' }));
      if (leaseLost) return;
      if (paused || stopping || controller.signal.aborted) return settle(service.releaseIneligible({ ...args, dueAt: clock() + 1_000 }));
      const attempt = await settle(service.beginAttempt({ ...args, messageID })); begun = true;
      const context = { ...deliveryPayload, messageID: attempt.messageID };
      const result = await settle(assistantDelivery
        ? service.sendAssistantDelivery({ ...context, deliveryTarget: item.deliveryConfig, parts }, { signal: controller.signal })
        : adapter.send({ ...context, parts }, { signal: controller.signal })); const status = statusOf(result);
      if (leaseLost) return;
      if (result?.ok || result?.accepted) return settle(service.markAmbiguous({ ...args, dueAt: clock() }));
      if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) return settle(service.markFailed({ ...args, errorCode: `http_${status}` }));
      if (result?.ambiguous || result?.kind === 'ambiguous' || status === 408 || status === 429 || status >= 500) return settle(service.markAmbiguous({ ...args, errorCode: result?.code ?? 'transport', dueAt: clock() }));
      return settle(service.scheduleRetry({ ...args, dueAt: clock() + retryDelay(attempt.attemptCount), errorCode: result?.code ?? 'pre_dispatch' }));
    } catch (error) {
      if (error?.code === 'lease_lost') return;
      const action = error?.code === 'stale_target' ? service.markFailed({ ...args, errorCode: 'stale_target' }) : begun ? service.markAmbiguous({ ...args, errorCode: 'transport', dueAt: clock() }) : paused || stopping || controller.signal.aborted ? service.releaseIneligible({ ...args, dueAt: clock() + 1_000 }) : service.scheduleRetry({ ...args, dueAt: clock() + retryDelay(item.attemptCount || 1), errorCode: 'pre_dispatch' });
      await settle(action).catch(() => {});
    } finally { clearInterval(heartbeat); controllers.delete(controller); }
  };
  const probe = async (candidate, runtimeKey, runtime) => {
    const controller = new AbortController(); controllers.add(controller); let timeout; let claimed = false;
    try {
      const { item } = candidate;
      const eligibility = await Promise.race([
        settle(adapter.checkEligibility({ scopeID: item.scopeID, directory: item.directory, sessionID: item.sessionID }, runtime, { signal: controller.signal })),
        new Promise((resolve) => { timeout = setTimeout(() => { controller.abort(); resolve({ available: false, timedOut: true }); }, ELIGIBILITY_TIMEOUT_MS); }),
        new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve({ available: false, aborted: true }), { once: true })),
      ]);
      if (paused || stopping || controller.signal.aborted) return;
      const dispatchable = candidate.dispatchMode === 'manual' ? eligibility?.available === true : eligibility?.available === true && eligibility.idle === true && eligibility.settled === true;
      if (!dispatchable) return;
      const claim = service.claimNext({ runtimeKey, owner: workerID, leaseMs, queueItemID: item.queueItemID, eligibilityToken: candidate.eligibilityToken });
      if (!claim) return;
      claimed = true;
      return await process(claim, eligibility, runtimeKey, runtime);
    } finally {
      clearTimeout(timeout); controllers.delete(controller);
      if (!claimed) await settle(service.deferEligibilityCandidate({ runtimeKey, queueItemID: candidate.item.queueItemID, eligibilityToken: candidate.eligibilityToken, fenceGeneration: candidate.fenceGeneration, delayMs: 1_000 })).catch(() => {});
    }
  };
  const reconcile = async (claim, runtimeKey, runtime) => {
    const entry = claim.item;
    const controller = new AbortController(); controllers.add(controller); let timeout;
    try {
      const result = await Promise.race([settle(adapter.findMessage({ directory: entry.directory, sessionID: entry.sessionID }, entry.messageID, { runtime, signal: controller.signal })), new Promise((resolve) => { timeout = setTimeout(() => { controller.abort(); resolve({ unavailable: true, code: 'reconcile_timeout' }); }, RECONCILE_TIMEOUT_MS); })]);
      if (result?.found) return settle(service.recordReconcileConfirmed({ queueItemID: entry.queueItemID, operationID: entry.operationID, messageID: entry.messageID, leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration, runtimeKey, source: 'query' }));
      const args = { queueItemID: entry.queueItemID, leaseToken: claim.leaseToken, fenceGeneration: claim.fenceGeneration, runtimeKey };
      return settle(result?.unavailable ? service.recordReconcileUnavailable(args) : service.recordReconcileMiss(args));
    } finally { clearTimeout(timeout); controllers.delete(controller); }
  };
  const run = async () => {
    if (paused || stopping) return status();
    const runtimeKey = service.getRuntimeKey(); const runtime = adapter.captureRuntime(); const authority = service.getAuthority({ runtimeKey });
    if (authority?.authority !== 'active') return status();
    service.recoverExpiredSending?.({ runtimeKey });
    while (!paused && !stopping) { const claim = service.claimDueReconcile?.({ runtimeKey, owner: workerID, leaseMs }); if (!claim) break; await reconcile(claim, runtimeKey, runtime); }
    while (!paused && !stopping && active.size < concurrency) { const candidate = service.reserveEligibilityCandidate({ runtimeKey, owner: workerID, leaseMs: Math.max(leaseMs, ELIGIBILITY_TIMEOUT_MS + 1_000) }); if (!candidate) break; const task = probe(candidate, runtimeKey, runtime).finally(() => active.delete(task)); active.add(task); }
    await Promise.all([...active]); return status();
  };
  const runOnce = () => {
    if (!flight) {
      wakeRequested = false;
      flight = run().finally(() => {
        flight = null; safeFlight = null;
        // admit / manualSend / session.idle may arrive while a probe is in flight.
        // Coalesce into one follow-up run instead of waiting for the 1s poll timer.
        if (wakeRequested && !paused && !stopping) void launch();
        else schedule();
      });
      safeFlight = flight.catch((error) => { console.error('message_queue_worker_run_failed', error); return status(); });
    } else {
      wakeRequested = true;
    }
    return flight;
  };
  const launch = () => { runOnce(); return safeFlight; };
  const schedule = () => { clearTimeout(timer); if (!paused && !stopping) timer = setTimeout(() => { void launch(); }, 1_000); };
  const start = () => {
    paused = false; stopping = false;
    void launch();
    return status();
  };
  const stop = async () => { paused = true; stopping = true; clearTimeout(timer); for (const controller of controllers) controller.abort(); await Promise.allSettled([flight, ...active].filter(Boolean)); stopping = false; return { ...status(), drained: active.size === 0 && !flight }; };
  const confirmByMessage = ({ directory, sessionID, messageID, source = 'event', runtimeKey = service.getRuntimeKey() }) => service.confirmByMessage({ runtimeKey, directory, sessionID, messageID, source });
  const status = () => ({ paused, active: active.size });
  return { start, stop, runOnce: launch, wake: launch, status, confirmByMessage };
};
