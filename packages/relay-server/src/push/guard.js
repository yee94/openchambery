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
  let generation = 1;
  let active = 0;
  let accepting = true;
  const waiters = [];
  const idleWaiters = [];
  const notifyIdle = () => {
    if (active !== 0) return;
    while (idleWaiters.length) idleWaiters.shift()();
  };
  return {
    acquire() {
      if (!accepting) return Promise.resolve(false);
      if (active < maxInFlight) {
        active += 1;
        return Promise.resolve(generation);
      }
      if (waiters.length >= maxWaiters) return Promise.resolve(false);
      const gen = generation;
      return new Promise((resolve) => {
        waiters.push(() => {
          if (!accepting || generation !== gen) { resolve(false); return; }
          resolve(generation);
        });
      });
    },
    release(ticket) {
      if (ticket !== generation) return;
      if (accepting) {
        const next = waiters.shift();
        if (next) { next(); return; }
      } else {
        while (waiters.length) waiters.shift()();
      }
      active = Math.max(0, active - 1);
      notifyIdle();
    },
    rejectWaiters() {
      accepting = false;
      while (waiters.length) waiters.shift()();
    },
    reset() {
      generation += 1;
      accepting = true;
      active = 0;
      waiters.length = 0;
      while (idleWaiters.length) idleWaiters.shift()();
    },
    whenIdle() {
      if (active === 0) return Promise.resolve();
      return new Promise((resolve) => { idleWaiters.push(resolve); });
    },
    get active() { return active; },
    get waiting() { return waiters.length; },
  };
};

export const createWorkTracker = () => {
  let generation = 1;
  let active = 0;
  const idleWaiters = [];
  const notifyIdle = () => {
    if (active !== 0) return;
    while (idleWaiters.length) idleWaiters.shift()();
  };
  return {
    begin() {
      active += 1;
      const gen = generation;
      return () => {
        if (gen !== generation) return;
        active = Math.max(0, active - 1);
        notifyIdle();
      };
    },
    whenIdle() {
      if (active === 0) return Promise.resolve();
      return new Promise((resolve) => { idleWaiters.push(resolve); });
    },
    reset() {
      generation += 1;
      active = 0;
      while (idleWaiters.length) idleWaiters.shift()();
    },
    get active() { return active; },
  };
};
