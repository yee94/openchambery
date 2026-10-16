import { Worker } from 'node:worker_threads';

const unavailable = () => Object.assign(new Error('push store unavailable'), { code: 'PUSH_STORE_UNAVAILABLE' });
const overloaded = () => Object.assign(new Error('push store busy'), { code: 'PUSH_STORE_BUSY' });

export const createCachedTokenStore = (databasePath, { maxTokens, maxPending = 64 } = {}) => {
  const records = new Map();
  let worker = null;
  let loading = null;
  let loaded = false;
  let closed = false;
  let retryAt = 0;
  let sequence = 0;
  let pending = 0;
  let tail = Promise.resolve();
  let active = null;
  let termination = Promise.resolve();
  let rejectLoading = null;

  const fail = () => {
    loaded = false;
    records.clear();
    retryAt = Date.now() + 5_000;
    rejectLoading?.();
    rejectLoading = null;
    active?.reject(unavailable());
    active = null;
    const previous = worker;
    worker = null;
    if (previous) termination = previous.terminate().catch(() => {});
  };
  const ready = () => {
    if (closed) return Promise.reject(unavailable());
    if (loaded) return Promise.resolve();
    if (loading) return loading;
    if (Date.now() < retryAt) return Promise.reject(unavailable());
    loading = termination.then(() => new Promise((resolve, reject) => {
      if (closed) { reject(unavailable()); return; }
      const current = new Worker(new URL('./store-worker.js', import.meta.url), { workerData: { databasePath, maxTokens } });
      worker = current;
      const timer = setTimeout(() => { fail(); reject(unavailable()); }, 10_000);
      rejectLoading = () => { clearTimeout(timer); reject(unavailable()); };
      const failed = () => {
        if (worker !== current) return;
        clearTimeout(timer);
        fail();
        reject(unavailable());
      };
      current.on('error', failed);
      current.on('exit', failed);
      current.on('message', async (message) => {
        if (worker !== current) return;
        if (message.rows) {
          for (let offset = 0; offset < message.rows.length; offset += 512) {
            if (worker !== current) return;
            for (const { token, ...record } of message.rows.slice(offset, offset + 512)) records.set(token, record);
            await new Promise((next) => setImmediate(next));
          }
          if (worker !== current) return;
          clearTimeout(timer);
          rejectLoading = null;
          loaded = true;
          resolve();
        } else if (active?.id === message.id) {
          const request = active;
          active = null;
          if (message.ok) request.resolve();
          else request.reject(unavailable());
        }
      });
    })).finally(() => { loading = null; });
    return loading;
  };
  const assertReady = () => { if (!loaded || closed) throw unavailable(); };
  const write = (operation, args, commit, skip) => {
    if (closed || !loaded) return Promise.reject(unavailable());
    if (pending >= maxPending) return Promise.reject(overloaded());
    pending += 1;
    const generation = worker;
    const deadline = Date.now() + 2_000;
    const result = tail.then(async () => {
      assertReady();
      if (worker !== generation) throw unavailable();
      if (Date.now() >= deadline) throw overloaded();
      if (skip?.()) return;
      await new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { fail(); }, Math.max(1, deadline - Date.now()));
        active = {
          id,
          resolve: () => { clearTimeout(timer); resolve(); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        };
        try { worker.postMessage({ id, operation, args }); } catch { fail(); }
      });
      assertReady();
      commit();
    }).finally(() => { pending -= 1; });
    tail = result.catch(() => {});
    return result;
  };
  return {
    ready,
    get(token) { assertReady(); return records.get(token) ?? null; },
    count() { assertReady(); return records.size; },
    upsert(token, serverId, platform, updatedAt) {
      return write('upsert', [token, serverId, platform, updatedAt], () => records.set(token, { serverId, platform, updatedAt }), () => {
        if (!records.has(token) && records.size >= maxTokens) throw overloaded();
        return false;
      });
    },
    delete(token, expected) {
      return write('delete', [token], () => records.delete(token), () => !records.has(token) || (expected !== undefined && records.get(token) !== expected));
    },
    async close() {
      closed = true;
      fail();
      await termination;
    },
  };
};
