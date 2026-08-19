import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('Android saveFile stages a cache file and never persists dataBase64', async () => {
  const [android, readme, docs] = await Promise.all([
    source('android/app/src/main/java/com/openchamber/app/OpenChamberMediaPlugin.java'),
    source('README.md'),
    source('../ui/src/sync/DOCUMENTATION.md'),
  ]);

  assert.match(android, /writeSaveCache\(bytes\)/);
  assert.match(android, /data\.remove\("dataBase64"\)/);
  assert.match(android, /intent\.setType\("application\/octet-stream"\)/);
  assert.match(android, /Intent\.ACTION_CREATE_DOCUMENT/);
  assert.match(android, /protected Bundle saveInstanceState\(\)/);
  assert.match(android, /STATE_PENDING_SAVE_PATH/);
  assert.match(android, /writeCacheToUri\(path, uri\)/);
  assert.doesNotMatch(android, /pendingSaveBytes/);
  assert.match(readme, /TransactionTooLargeException/);
  assert.match(readme, /application\/octet-stream/);
  assert.match(docs, /TransactionTooLarge/);
  assert.match(docs, /application\/octet-stream/);
});
