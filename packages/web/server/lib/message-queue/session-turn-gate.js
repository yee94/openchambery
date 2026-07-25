const DEFAULT_INCOMPLETE_ASSISTANT_GRACE_MS = 3_000;
const DEFAULT_USER_TAIL_GRACE_MS = 10_000;
const DEFAULT_CLIENT_PREEMPT_MS = 2_000;
const DEFAULT_MAX_ENTRIES = 128;

const observationRequirement = (role, options) => role === 'assistant'
  ? { graceMs: options.incompleteAssistantGraceMs, probes: 2, reason: 'stopped_assistant' }
  : { graceMs: options.userTailGraceMs, probes: 3, reason: role === 'user' ? 'aborted_before_assistant' : 'unknown_tail_stable' };

export const createSessionTurnGate = ({
  clock = () => Date.now(),
  incompleteAssistantGraceMs = DEFAULT_INCOMPLETE_ASSISTANT_GRACE_MS,
  userTailGraceMs = DEFAULT_USER_TAIL_GRACE_MS,
  clientPreemptMs = DEFAULT_CLIENT_PREEMPT_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) => {
  const entries = new Map();
  let tokenSequence = 0;
  const options = { incompleteAssistantGraceMs, userTailGraceMs };

  const resetObservation = (entry) => {
    entry.fingerprint = null;
    entry.firstStableAt = null;
    entry.probeCount = 0;
    entry.ready = false;
  };
  const touch = (entry, now) => { entry.lastTouchedAt = now; };
  const prune = (now) => {
    if (entries.size < maxEntries) return;
    for (const [key, entry] of entries) {
      if (!entry.activeToken && entry.clientFenceUntil <= now && now - entry.lastTouchedAt >= userTailGraceMs) entries.delete(key);
      if (entries.size < maxEntries) return;
    }
    const oldest = [...entries.entries()].sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt)[0];
    if (oldest) entries.delete(oldest[0]);
  };
  const ensure = (key) => {
    const current = entries.get(key);
    if (current) return current;
    const now = clock(); prune(now);
    const entry = { activity: 'unknown', idleObservedAt: null, fingerprint: null, firstStableAt: null, probeCount: 0, ready: false, epoch: 0, activeToken: null, clientFenceUntil: 0, lastTouchedAt: now };
    entries.set(key, entry);
    return entry;
  };

  const observeEvent = (key, phase) => {
    const entry = entries.get(key);
    if (!entry) return false;
    const now = clock(); touch(entry, now);
    if (phase === 'busy' || phase === 'retry') {
      entry.activity = phase;
      entry.idleObservedAt = null;
      entry.clientFenceUntil = 0;
      entry.epoch += 1;
      entry.activeToken = null;
      resetObservation(entry);
      return true;
    }
    if (phase === 'idle' || phase === 'error') {
      if (entry.activity !== 'idle') {
        entry.idleObservedAt = now;
        resetObservation(entry);
      }
      entry.activity = 'idle';
      entry.clientFenceUntil = 0;
      entry.epoch += 1;
      entry.activeToken = null;
      return true;
    }
    return false;
  };

  const noteClientOperation = (key) => {
    const entry = ensure(key); const now = clock();
    touch(entry, now);
    entry.epoch += 1;
    entry.activeToken = null;
    entry.activity = 'unknown';
    entry.idleObservedAt = null;
    entry.clientFenceUntil = now + clientPreemptMs;
    resetObservation(entry);
  };

  const evaluate = (key, { available, idle, tailID, tailRole, tailCompleted }) => {
    const entry = ensure(key); const now = clock(); touch(entry, now);
    if (!available) {
      entry.activity = 'unknown'; entry.idleObservedAt = null; entry.activeToken = null; entry.epoch += 1; resetObservation(entry);
      return { ready: false, reason: 'unavailable' };
    }
    if (entry.clientFenceUntil > now) return { ready: false, reason: 'client_preempted', nextCheckAt: entry.clientFenceUntil };
    if (!idle) {
      if (entry.activity !== 'busy') entry.epoch += 1;
      entry.activity = 'busy'; entry.idleObservedAt = null; entry.activeToken = null; resetObservation(entry);
      return { ready: false, reason: 'busy' };
    }
    if (entry.activity !== 'idle') {
      entry.activity = 'idle';
      entry.idleObservedAt = now;
      resetObservation(entry);
    }
    if (!tailID) {
      resetObservation(entry);
      entry.ready = tailRole == null;
      return { ready: entry.ready, reason: entry.ready ? 'empty_history' : 'tail_identity_missing' };
    }
    if (tailRole === 'assistant' && tailCompleted) {
      resetObservation(entry); entry.ready = true;
      return { ready: true, reason: 'completed_assistant' };
    }
    const fingerprint = JSON.stringify([tailID, tailRole ?? null, false]);
    if (entry.fingerprint !== fingerprint) {
      entry.fingerprint = fingerprint;
      entry.firstStableAt = entry.idleObservedAt ?? now;
      entry.probeCount = 1;
      entry.ready = false;
    } else {
      entry.probeCount += 1;
    }
    const requirement = observationRequirement(tailRole, options);
    const nextCheckAt = entry.firstStableAt + requirement.graceMs;
    entry.ready = entry.probeCount >= requirement.probes && now >= nextCheckAt;
    return { ready: entry.ready, reason: entry.ready ? requirement.reason : 'tail_unsettled', nextCheckAt };
  };

  const acquireAutomatic = (key) => {
    const entry = ensure(key); const now = clock(); touch(entry, now);
    if (!entry.ready || entry.clientFenceUntil > now || entry.activeToken) return null;
    const token = { key, epoch: entry.epoch, id: ++tokenSequence };
    entry.activeToken = token;
    return token;
  };
  const validateAutomatic = (token) => {
    const entry = token && entries.get(token.key); const now = clock();
    return Boolean(entry && entry.activeToken === token && entry.epoch === token.epoch && entry.clientFenceUntil <= now);
  };
  const finishAutomatic = (token, { accepted = false } = {}) => {
    const entry = token && entries.get(token.key);
    if (!entry || entry.activeToken !== token) return false;
    const now = clock(); touch(entry, now);
    entry.activeToken = null;
    entry.epoch += 1;
    if (accepted) {
      entry.activity = 'unknown';
      entry.idleObservedAt = null;
      entry.clientFenceUntil = now + clientPreemptMs;
      resetObservation(entry);
    }
    return true;
  };

  return { observeEvent, noteClientOperation, evaluate, acquireAutomatic, validateAutomatic, finishAutomatic, size: () => entries.size };
};
