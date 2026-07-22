import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageQueueWorker } from './worker.js';

const claim = { item: { queueItemID: 'item', scopeID: 'scope', directory: '/repo', sessionID: 'session', content: 'hello', attemptCount: 0, attachments: [] }, leaseToken: 'lease', leaseExpiresAt: 10, fenceGeneration: 1 };
const candidate = { item: claim.item, eligibilityToken: 'eligibility', leaseExpiresAt: 20_000, fenceGeneration: 1, dispatchMode: 'automatic' };
const reconcileClaim = { item: { queueItemID: 'reconcile-item', directory: '/repo', sessionID: 'session', messageID: 'msg_0000000001' }, leaseToken: 'reconcile-lease', fenceGeneration: 1 };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const setup = ({ result = { ok: true }, service: serviceOverrides = {}, adapter: adapterOverrides = {}, worker: workerOptions = {} } = {}) => {
  const service = {
    getRuntimeKey: vi.fn(() => 'runtime'), getAuthority: vi.fn(() => ({ authority: 'active', generation: 1 })), claimDueReconcile: vi.fn(() => null), reserveEligibilityCandidate: vi.fn().mockReturnValueOnce(candidate).mockReturnValue(null), deferEligibilityCandidate: vi.fn(), claimNext: vi.fn().mockReturnValueOnce(claim).mockReturnValue(null), renewLease: vi.fn(), releaseIneligible: vi.fn(), beginAttempt: vi.fn(() => ({ messageID: 'msg_0000000001', attemptCount: 1 })), completeAttempt: vi.fn(), scheduleRetry: vi.fn(), markAmbiguous: vi.fn(), markFailed: vi.fn(), recordReconcileUnavailable: vi.fn(), recordReconcileMiss: vi.fn(), recordReconcileConfirmed: vi.fn(), confirmByMessage: vi.fn(), close: vi.fn(), ...serviceOverrides,
  };
  const adapter = {
    captureRuntime: vi.fn(() => ({ token: 'r' })), checkEligibility: vi.fn(() => ({ available: true, idle: true, settled: true, latestMessageID: 'msg_0000000000' })), createMessageID: vi.fn(() => 'msg_0000000001'), materializeAttachments: vi.fn(() => []), send: vi.fn(() => result), findMessage: vi.fn(), ...adapterOverrides,
  };
  return { service, adapter, worker: createMessageQueueWorker({ service, adapter, workerID: 'worker', ...workerOptions }) };
};

afterEach(() => vi.useRealTimers());

describe('message queue worker', () => {
  it('starts paused then claims, sends, and reconciles accepted delivery with captured fencing', async () => {
    const { worker, service } = setup();
    await worker.runOnce();
    expect(service.claimNext).toHaveBeenCalledTimes(0);
    worker.start();
    await worker.wake();
    expect(service.claimNext).toHaveBeenCalledWith({ runtimeKey: 'runtime', owner: 'worker', leaseMs: 15000, queueItemID: 'item', eligibilityToken: 'eligibility' });
    expect(service.completeAttempt).not.toHaveBeenCalled();
    expect(service.markAmbiguous).toHaveBeenCalledWith(expect.objectContaining({ queueItemID: 'item', leaseToken: 'lease', fenceGeneration: 1, runtimeKey: 'runtime', dueAt: expect.any(Number) }));
    await worker.stop();
  });

  it('delivers an Assistant claim through its captured target and compiled payload', async () => {
    const deliveryParts = [{ type: 'text', text: 'first' }, { type: 'file', mime: 'text/plain', url: 'https://files.example/one' }, { type: 'text', text: 'last' }];
    const deliveryConfig = { kind: 'assistant', assistantID: 'assistant-1', providerID: 'provider', modelID: 'model', binding: { sessionID: 'session', directory: '/repo', sessionGeneration: 1 }, deliveryParts };
    const assistantItem = { ...claim.item, deliveryTarget: { kind: 'assistant', assistantID: 'assistant-1' }, deliveryParts, deliveryConfig };
    const { worker, service, adapter } = setup({ service: { reserveEligibilityCandidate: vi.fn().mockReturnValueOnce({ ...candidate, item: assistantItem }).mockReturnValue(null), claimNext: vi.fn().mockReturnValueOnce({ ...claim, item: assistantItem }).mockReturnValue(null), sendAssistantDelivery: vi.fn(() => ({ ok: true })) } });
    worker.start(); await worker.wake();
    expect(adapter.materializeAttachments).not.toHaveBeenCalled();
    expect(service.sendAssistantDelivery).toHaveBeenCalledWith(expect.objectContaining({ deliveryTarget: deliveryConfig, parts: deliveryParts }), expect.any(Object));
    await worker.stop();
  });

  it('settles stale and malformed Assistant targets as isolated failed items', async () => {
    const staleItem = { ...claim.item, deliveryTarget: { kind: 'assistant', assistantID: 'assistant-1' }, deliveryParts: [{ type: 'text', text: 'captured' }], deliveryConfig: { kind: 'assistant', assistantID: 'assistant-1' } };
    const { worker, service } = setup({ service: { reserveEligibilityCandidate: vi.fn().mockReturnValueOnce({ ...candidate, item: staleItem }).mockReturnValue(null), claimNext: vi.fn().mockReturnValueOnce({ ...claim, item: staleItem }).mockReturnValue(null), sendAssistantDelivery: vi.fn(() => { throw Object.assign(new Error('stale'), { code: 'stale_target' }); }) } });
    worker.start(); await worker.wake(); expect(service.markFailed).toHaveBeenCalledWith(expect.objectContaining({ queueItemID: 'item', errorCode: 'stale_target' })); await worker.stop();
    const malformedItem = { ...claim.item, deliveryTarget: { kind: 'assistant' } };
    const malformed = setup({ service: { reserveEligibilityCandidate: vi.fn().mockReturnValueOnce({ ...candidate, item: malformedItem }).mockReturnValue(null), claimNext: vi.fn().mockReturnValueOnce({ ...claim, item: malformedItem }).mockReturnValue(null) } });
    malformed.worker.start(); await malformed.worker.wake(); expect(malformed.service.markFailed).toHaveBeenCalledWith(expect.objectContaining({ queueItemID: 'item', errorCode: 'malformed_target' })); await malformed.worker.stop();
  });

  it('returns status before a run flight settles and reports a background rejection', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { worker } = setup({ service: { claimDueReconcile: vi.fn(() => { throw new Error('claim failed'); }) } });
    expect(worker.start()).toEqual({ paused: false, active: 0 });
    await flush();
    expect(diagnostic).toHaveBeenCalledWith('message_queue_worker_run_failed', expect.objectContaining({ message: 'claim failed' }));
    diagnostic.mockRestore();
    await worker.stop();
  });

  it('diagnoses a failed timer flight and permits a later wake retry', async () => {
    vi.useFakeTimers();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reserveEligibilityCandidate = vi.fn().mockReturnValueOnce(null).mockImplementationOnce(() => { throw new Error('timer claim failed'); }).mockReturnValue(null);
    const { worker } = setup({ service: { reserveEligibilityCandidate } });
    worker.start();
    await worker.wake();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(diagnostic).toHaveBeenCalledWith('message_queue_worker_run_failed', expect.objectContaining({ message: 'timer claim failed' }));
    await expect(worker.wake()).resolves.toEqual({ paused: false, active: 0 });
    await expect(worker.stop()).resolves.toMatchObject({ drained: true, active: 0 });
    diagnostic.mockRestore();
  });

  it('settles an event wake after reconcile adapter failure and retries safely', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { worker } = setup({ service: { claimDueReconcile: vi.fn().mockReturnValueOnce(reconcileClaim).mockReturnValue(null) }, adapter: { findMessage: vi.fn(() => { throw new Error('event reconcile failed'); }) } });
    worker.start();
    await expect(worker.wake()).resolves.toEqual({ paused: false, active: 0 });
    expect(diagnostic).toHaveBeenCalledWith('message_queue_worker_run_failed', expect.objectContaining({ message: 'event reconcile failed' }));
    await expect(worker.wake()).resolves.toEqual({ paused: false, active: 0 });
    diagnostic.mockRestore();
    await worker.stop();
  });

  it('classifies definitive, retry, and ambiguous results', async () => {
    for (const [result, method] of [[{ status: 400 }, 'markFailed'], [{ kind: 'retry' }, 'scheduleRetry'], [{ status: 503 }, 'markAmbiguous']]) {
      const { worker, service } = setup({ result });
      worker.start();
      await worker.wake();
      expect(service[method]).toHaveBeenCalledWith(expect.objectContaining({ queueItemID: 'item', leaseToken: 'lease', fenceGeneration: 1, runtimeKey: 'runtime' }));
      await worker.stop();
    }
  });

  it('leaves automatic busy and unsettled candidates queued before claiming', async () => {
    const { worker, service, adapter } = setup({ adapter: { checkEligibility: vi.fn(() => ({ available: true, idle: false, settled: false })) } });
    worker.start(); await worker.wake();
    expect(service.claimNext).toHaveBeenCalledTimes(0); expect(service.deferEligibilityCandidate).toHaveBeenCalledTimes(1); expect(service.releaseIneligible).toHaveBeenCalledTimes(0); expect(adapter.send).toHaveBeenCalledTimes(0); expect(service.beginAttempt).toHaveBeenCalledTimes(0);
    await worker.stop();
  });

  it('sends a manual available claim once while busy and unsettled', async () => {
    const manualClaim = { ...claim, dispatchMode: 'manual' };
    const { worker, service, adapter } = setup({ service: { reserveEligibilityCandidate: vi.fn().mockReturnValueOnce({ ...candidate, item: manualClaim.item, dispatchMode: 'manual' }).mockReturnValue(null), claimNext: vi.fn().mockReturnValueOnce(manualClaim).mockReturnValue(null) }, adapter: { checkEligibility: vi.fn(() => ({ available: true, idle: false, settled: false, latestMessageID: 'msg_0000000000' })) } });
    worker.start(); await worker.wake();
    expect(service.beginAttempt).toHaveBeenCalledTimes(1); expect(adapter.send).toHaveBeenCalledTimes(1); expect(service.releaseIneligible).toHaveBeenCalledTimes(0);
    await worker.stop();
  });

  it('leaves an unavailable manual candidate queued before claiming', async () => {
    const manualClaim = { ...claim, dispatchMode: 'manual' };
    const { worker, service, adapter } = setup({ service: { reserveEligibilityCandidate: vi.fn().mockReturnValueOnce({ ...candidate, item: manualClaim.item, dispatchMode: 'manual' }).mockReturnValue(null), claimNext: vi.fn().mockReturnValueOnce(manualClaim).mockReturnValue(null) }, adapter: { checkEligibility: vi.fn(() => ({ available: false, idle: true, settled: true })) } });
    worker.start(); await worker.wake();
    expect(service.claimNext).toHaveBeenCalledTimes(0); expect(service.deferEligibilityCandidate).toHaveBeenCalledTimes(1); expect(service.releaseIneligible).toHaveBeenCalledTimes(0); expect(adapter.send).toHaveBeenCalledTimes(0); expect(service.beginAttempt).toHaveBeenCalledTimes(0);
    await worker.stop();
  });

  it('confirms event messages through the service API', async () => {
    const { worker, service } = setup();
    await worker.confirmByMessage({ directory: '/repo', sessionID: 'session', messageID: 'msg_1' });
    expect(service.confirmByMessage).toHaveBeenCalledWith({ runtimeKey: 'runtime', directory: '/repo', sessionID: 'session', messageID: 'msg_1', source: 'event' });
    await worker.stop();
  });

  it('renews a short lease repeatedly while dispatch remains active', async () => {
    vi.useFakeTimers();
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { worker, service } = setup({ adapter: { send: vi.fn(() => pending) }, worker: { leaseMs: 3 } });
    worker.start();
    await flush();
    await vi.advanceTimersByTimeAsync(4);
    expect(service.renewLease).toHaveBeenCalledTimes(4);
    expect(service.renewLease).toHaveBeenLastCalledWith({ queueItemID: 'item', leaseToken: 'lease', fenceGeneration: 1, runtimeKey: 'runtime', leaseMs: 3 });
    release({ ok: true });
    await flush();
    expect(service.completeAttempt).toHaveBeenCalledTimes(0);
    expect(service.markAmbiguous).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it.each([
    ['同步抛出', () => { throw Object.assign(new Error('lost'), { code: 'lease_lost' }); }],
    ['Promise rejection', () => Promise.reject(Object.assign(new Error('lost'), { code: 'lease_lost' }))],
  ])('在heartbeat %s lease_lost后中止发送并禁止completion', async (_kind, renewLease) => {
    vi.useFakeTimers();
    let release;
    let signal;
    const pending = new Promise((resolve) => { release = resolve; });
    const { worker, service } = setup({ service: { renewLease: vi.fn(renewLease) }, adapter: { send: vi.fn((_context, options) => { signal = options.signal; return pending; }) }, worker: { leaseMs: 3 } });
    worker.start();
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(signal.aborted).toBe(true);
    release({ ok: true });
    await flush();
    expect(service.completeAttempt).toHaveBeenCalledTimes(0);
    await worker.stop();
  });

  it('在hung reconcile超时后将绝对deadline交由service记录为unavailable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const deadlineAt = 10_000;
    let signal;
    const service = {
      claimDueReconcile: vi.fn().mockReturnValueOnce(reconcileClaim).mockReturnValue(null),
      recordReconcileUnavailable: vi.fn((args) => ({ ...args, deadlineAt, unresolved: Date.now() >= deadlineAt })),
      reserveEligibilityCandidate: vi.fn(() => null),
    };
    const { worker, adapter } = setup({ service, adapter: { findMessage: vi.fn((_scope, _messageID, options) => { signal = options.signal; return new Promise(() => {}); }) } });
    worker.start();
    await flush();
    await vi.advanceTimersByTimeAsync(deadlineAt);
    await flush();
    expect(signal.aborted).toBe(true);
    expect(service.recordReconcileUnavailable).toHaveBeenCalledWith({ queueItemID: 'reconcile-item', leaseToken: 'reconcile-lease', fenceGeneration: 1, runtimeKey: 'runtime' });
    expect(service.recordReconcileUnavailable.mock.results[0].value).toMatchObject({ deadlineAt, unresolved: true });
    await worker.stop();
  });

  it('将并发wake合并为单个claim和reconcile flight', async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { worker, service, adapter } = setup({
      service: { claimDueReconcile: vi.fn().mockReturnValueOnce(reconcileClaim).mockReturnValue(null), reserveEligibilityCandidate: vi.fn(() => null) },
      adapter: { findMessage: vi.fn(() => pending) },
    });
    worker.start();
    await flush();
    const first = worker.wake();
    const second = worker.wake();
    expect(first).toBe(second);
    release({ found: true });
    await first;
    expect(adapter.findMessage).toHaveBeenCalledTimes(1);
    expect(service.recordReconcileConfirmed).toHaveBeenCalledTimes(1);
    expect(service.reserveEligibilityCandidate).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it('在adapter忽略abort时保持pending，settle后drained且runtime负责service close', async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { worker, service } = setup({ adapter: { send: vi.fn(() => pending) } });
    void worker.start();
    await flush();
    const stopping = worker.stop();
    let settled = false;
    void stopping.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    expect(service.close).toHaveBeenCalledTimes(0);
    release({ ok: true });
    await expect(stopping).resolves.toMatchObject({ drained: true, active: 0 });
    expect(service.close).toHaveBeenCalledTimes(0);
  });

  it('停止期间中断忽略 abort 的 eligibility probe 且不获取发送租约', async () => {
    const pending = new Promise(() => {});
    const { worker, service, adapter } = setup({ adapter: { checkEligibility: vi.fn(() => pending) } });
    worker.start();
    await flush();
    await expect(worker.stop()).resolves.toMatchObject({ drained: true, active: 0 });
    expect(service.claimNext).toHaveBeenCalledTimes(0);
    expect(service.deferEligibilityCandidate).toHaveBeenCalledTimes(1);
    expect(adapter.send).toHaveBeenCalledTimes(0);
  });

  it('停止期间等待忽略 abort 的附件预检并在 beginAttempt 前释放租约', async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { worker, service, adapter } = setup({ adapter: { materializeAttachments: vi.fn(() => pending) } });
    worker.start();
    await flush();
    const stopping = worker.stop();
    await flush();
    release([]);
    await expect(stopping).resolves.toMatchObject({ drained: true, active: 0 });
    expect(service.beginAttempt).toHaveBeenCalledTimes(0);
    expect(service.releaseIneligible).toHaveBeenCalledTimes(1);
    expect(adapter.send).toHaveBeenCalledTimes(0);
  });
});
