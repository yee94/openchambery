import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { expect, test } from 'vitest';
import { evidenceRoot, openChromeSession, openPageSession, resolveChrome } from '../components/ui/chromeCdpHarness';

test.skipIf(!resolveChrome())('real IndexedDB preserves blobs, retries aborted copy, and never restores deleted new records', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = stripTypeScriptTypes(readFileSync(join(here, 'brand-storage-migration.ts'), 'utf8'), { mode: 'strip' }).replace(/\bexport\s+/g, '');
  const work = mkdtempSync(join(evidenceRoot(), 'brand-storage-'));
  const file = join(work, 'index.html');
  writeFileSync(file, '<title>Yuri storage migration evidence</title>');
  const browser = await openChromeSession({ width: 800, height: 600 });
  try {
    const page = await openPageSession(browser, { width: 800, height: 600, standalone: false });
    await page.navigateFile(file);
    const result = await page.evaluate<{ original: string; migrated: string; afterDelete: number; failed: boolean; retried: string; freshLegacy: boolean }>(`(async () => {
      ${source}
      const open = (name, create) => new Promise((resolve, reject) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => { const store = r.result.createObjectStore('blobs', {keyPath: 'id'}); store.createIndex('label', 'label'); };
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      const run = (db, mode, action) => new Promise((resolve, reject) => {
        const tx = db.transaction('blobs', mode); let result;
        const r = action(tx.objectStore('blobs'));
        r.onsuccess = () => { result = r.result; };
        tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error);
      });
      const legacy = await open('openchamber-input-drafts');
      await run(legacy, 'readwrite', store => store.put({id:'draft', label:'original', blob:new Blob(['draft bytes'])}));
      await migrateBrandIndexedDB('yuri-input-drafts');
      const next = await open('yuri-input-drafts');
      const original = await (await run(legacy, 'readonly', store => store.get('draft'))).blob.text();
      const migrated = await (await run(next, 'readonly', store => store.get('draft'))).blob.text();
      await run(next, 'readwrite', store => store.delete('draft'));
      flights.clear();
      await migrateBrandIndexedDB('yuri-input-drafts');
      const afterDelete = await run(next, 'readonly', store => store.count());
      legacy.close(); next.close();
      const legacy2 = await open('openchamber-transcript-durable');
      await run(legacy2, 'readwrite', store => store.put({id:'transcript', label:'saved', blob:new Blob(['transcript bytes'])}));
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function(...args) { this.transaction.abort(); return add.apply(this, args); };
      let failed = false;
      try { await migrateBrandIndexedDB('yuri-transcript-durable'); } catch { failed = true; }
      IDBObjectStore.prototype.add = add;
      await migrateBrandIndexedDB('yuri-transcript-durable');
      const next2 = await open('yuri-transcript-durable');
      const retried = await (await run(next2, 'readonly', store => store.get('transcript'))).blob.text();
      next2.close(); legacy2.close();
      await migrateBrandIndexedDB('yuri-assistant-attachments');
      const freshLegacy = (await indexedDB.databases()).some(db => db.name === 'openchamber-assistant-attachments');
      return { original, migrated, afterDelete, failed, retried, freshLegacy };
    })()`);
    expect(result).toEqual({ original: 'draft bytes', migrated: 'draft bytes', afterDelete: 0, failed: true, retried: 'transcript bytes', freshLegacy: false });
  } finally {
    await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);
