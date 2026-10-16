import { parentPort, workerData } from 'node:worker_threads';
import { createTokenStore } from './store.js';

const store = createTokenStore(workerData.databasePath, { busyTimeoutMs: 250 });
parentPort.postMessage({ rows: store.entries(workerData.maxTokens) });
parentPort.on('message', ({ id, operation, args }) => {
  try {
    if (operation === 'upsert') store.upsert(...args);
    else if (operation === 'delete') store.delete(...args);
    else throw new Error('invalid operation');
    parentPort.postMessage({ id, ok: true });
  } catch {
    parentPort.postMessage({ id, ok: false });
  }
});
