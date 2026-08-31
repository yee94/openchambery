export const createReplayGuard = ({ replayMs, maxReplayEntries, now }) => {
  const replay = new Map();
  const purge = () => {
    const ts = now();
    for (const [key, expiry] of replay) if (expiry <= ts) replay.delete(key);
  };
  return {
    has(key) {
      purge();
      return replay.has(key);
    },
    remember(key) {
      purge();
      if (replay.size >= maxReplayEntries && !replay.has(key)) return false;
      replay.set(key, now() + replayMs);
      return true;
    },
    clear() { replay.clear(); },
    get size() { return replay.size; },
  };
};

export const createSlidingWindowLimiter = ({ windowMs, maxCount, maxEntries, now }) => {
  const entries = new Map();
  const pruneKey = (key, cutoff) => {
    const stamps = entries.get(key);
    if (!stamps) return null;
    let index = 0;
    while (index < stamps.length && stamps[index] <= cutoff) index += 1;
    if (index) stamps.splice(0, index);
    if (stamps.length === 0) { entries.delete(key); return null; }
    return stamps;
  };
  const purge = (cutoff) => {
    for (const key of [...entries.keys()]) pruneKey(key, cutoff);
  };
  return {
    allow(key) {
      const ts = now();
      const cutoff = ts - windowMs;
      let stamps = pruneKey(key, cutoff);
      if (!stamps) {
        if (entries.size >= maxEntries) {
          purge(cutoff);
          if (entries.size >= maxEntries) return false;
        }
        stamps = [];
        entries.set(key, stamps);
      }
      if (stamps.length >= maxCount) return false;
      stamps.push(ts);
      return true;
    },
    clear() { entries.clear(); },
  };
};

export const createInFlightGate = (maxInFlight) => {
  const maxWaiters = maxInFlight;
  let active = 0;
  const waiters = [];
  return {
    acquire() {
      if (active < maxInFlight) { active += 1; return Promise.resolve(true); }
      if (waiters.length >= maxWaiters) return Promise.resolve(false);
      return new Promise((resolve) => { waiters.push(resolve); });
    },
    release() {
      const next = waiters.shift();
      if (next) next(true);
      else active = Math.max(0, active - 1);
    },
    clear() {
      while (waiters.length) waiters.shift()(false);
      active = 0;
    },
    get active() { return active; },
    get waiting() { return waiters.length; },
  };
};
