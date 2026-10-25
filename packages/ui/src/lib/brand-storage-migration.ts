/** Same-origin, copy-only migration. Historical names are migration inputs only. */
const LEGACY_BRANDS = ['openchambery', 'openchamber'] as const;
const KEY_MARKER = 'yuri.migration.storage.';
const DATABASE_MARKER_STORE = '__yuri_brand_migration';
const DATABASES = new Set([
  'yuri-input-drafts', 'yuri-assistant-attachments', 'yuri-transcript-durable',
  'yuri-transcript-search', 'yuri-transcript-diagnostics',
]);

const renameBaseKey = (key: string): string => {
  for (const brand of LEGACY_BRANDS) {
    if (key === brand || key.startsWith(`${brand}.`) || key.startsWith(`${brand}_`) || key.startsWith(`${brand}-`)) {
      return `yuri${key.slice(brand.length)}`;
    }
  }
  if (/^oc[.:-]/.test(key)) return `yuri${key.slice(2)}`;
  return key;
};

export const migratedStorageKey = (key: string): string => {
  // The encoded host identity is opaque; only the scope and base-key namespaces change.
  const scoped = /^(oc|yuri)\.(rt|inst)\.([^.]+)\.(.*)$/.exec(key);
  if (scoped) return `yuri.${scoped[2]}.${scoped[3]}.${renameBaseKey(scoped[4])}`;
  return renameBaseKey(key);
};

export type BrandStorageMigrationResult = { copied: number; preserved: number; failed: string[] };

export function migrateBrandLocalStorage(storage: Storage): BrandStorageMigrationResult {
  const result: BrandStorageMigrationResult = { copied: 0, preserved: 0, failed: [] };
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key !== null);
  // Prefer the most recent legacy namespace when both generations are present.
  keys.sort((a, b) => Number(b.startsWith(LEGACY_BRANDS[0])) - Number(a.startsWith(LEGACY_BRANDS[0])));
  for (const key of keys) {
    const target = migratedStorageKey(key);
    if (key === target) continue;
    const marker = `${KEY_MARKER}${encodeURIComponent(target)}`;
    try {
      if (storage.getItem(marker) === '1') continue;
      const existing = storage.getItem(target);
      if (existing !== null) {
        result.preserved++;
      } else {
        const value = storage.getItem(key);
        if (value === null) continue;
        storage.setItem(target, value);
        if (storage.getItem(target) !== value) throw new Error('Storage migration verification failed');
        result.copied++;
      }
      // A tombstone prevents deleted Yuri data from being resurrected on later launches.
      storage.setItem(marker, '1');
    } catch {
      result.failed.push(target);
    }
  }
  return result;
}

type StoreSnapshot = {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
  rows: { key: IDBValidKey; value: unknown }[];
};

const openExisting = (factory: IDBFactory, name: string): Promise<IDBDatabase | null> => new Promise((resolve, reject) => {
  const request = factory.open(name);
  let absent = false;
  let blocked = false;
  request.onupgradeneeded = () => {
    // Abort rather than creating an empty legacy database on fresh installations.
    absent = true;
    request.transaction?.abort();
  };
  request.onsuccess = () => {
    if (blocked) request.result.close();
    else resolve(request.result);
  };
  request.onerror = () => absent ? resolve(null) : reject(request.error);
  request.onblocked = () => { blocked = true; reject(new Error('Legacy database is blocked')); };
});

const snapshotDatabase = (database: IDBDatabase): Promise<StoreSnapshot[]> => new Promise((resolve, reject) => {
  const names = Array.from(database.objectStoreNames);
  if (!names.length) { resolve([]); return; }
  const transaction = database.transaction(names, 'readonly');
  const snapshots = names.map((name): StoreSnapshot => {
    const store = transaction.objectStore(name);
    const snapshot: StoreSnapshot = {
      name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, rows: [],
      indexes: Array.from(store.indexNames).map((indexName) => {
        const index = store.index(indexName);
        return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
      }),
    };
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      snapshot.rows.push({ key: cursor.result.primaryKey, value: cursor.result.value });
      cursor.result.continue();
    };
    return snapshot;
  });
  transaction.oncomplete = () => resolve(snapshots);
  transaction.onabort = () => reject(transaction.error ?? new Error('Legacy database snapshot aborted'));
  transaction.onerror = () => { /* onabort owns the terminal failure. */ };
});

const copyDatabase = async (factory: IDBFactory, name: string, legacy: IDBDatabase): Promise<void> => {
  const snapshots = await snapshotDatabase(legacy);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, legacy.version);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (blocked) { request.transaction?.abort(); return; }
      const target = request.result;
      for (const snapshot of snapshots) {
        const store = target.createObjectStore(snapshot.name, { keyPath: snapshot.keyPath, autoIncrement: snapshot.autoIncrement });
        for (const index of snapshot.indexes) store.createIndex(index.name, index.keyPath, index);
      }
      target.createObjectStore(DATABASE_MARKER_STORE);
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('Yuri database migration is blocked')); };
  });
  try {
    // An independently initialized Yuri database has authoritative ownership.
    if (!database.objectStoreNames.contains(DATABASE_MARKER_STORE)) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([...snapshots.map((store) => store.name), DATABASE_MARKER_STORE], 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Database migration aborted'));
      transaction.onerror = () => { /* onabort owns the terminal failure. */ };
      const marker = transaction.objectStore(DATABASE_MARKER_STORE);
      const completed = marker.get('complete');
      completed.onsuccess = () => {
        if (completed.result === true) return;
        for (const snapshot of snapshots) {
          const store = transaction.objectStore(snapshot.name);
          for (const row of snapshot.rows) {
            const existing = store.count(row.key);
            existing.onsuccess = () => {
              if (existing.result !== 0) return;
              if (snapshot.keyPath === null) store.add(row.value, row.key);
              else store.add(row.value);
            };
          }
        }
        // The marker and all records commit or abort together.
        marker.put(true, 'complete');
      };
    });
  } finally {
    database.close();
  }
};

const flights = new Map<string, Promise<void>>();

export function migrateBrandIndexedDB(name: string, factory: IDBFactory = globalThis.indexedDB): Promise<void> {
  if (!factory || !DATABASES.has(name)) return Promise.resolve();
  const existing = flights.get(name);
  if (existing) return existing;
  const flight = (async () => {
    const target = await openExisting(factory, name);
    if (target) {
      try {
        if (!target.objectStoreNames.contains(DATABASE_MARKER_STORE)) return;
        const complete = await new Promise<boolean>((resolve, reject) => {
          const transaction = target.transaction(DATABASE_MARKER_STORE, 'readonly');
          const request = transaction.objectStore(DATABASE_MARKER_STORE).get('complete');
          transaction.oncomplete = () => resolve(request.result === true);
          transaction.onabort = () => reject(transaction.error ?? new Error('Migration state unavailable'));
        });
        if (complete) return;
      } finally { target.close(); }
    }
    for (const brand of LEGACY_BRANDS) {
      const legacy = await openExisting(factory, `${brand}${name.slice(4)}`);
      if (!legacy) continue;
      try { await copyDatabase(factory, name, legacy); } finally { legacy.close(); }
      break;
    }
  })();
  flights.set(name, flight);
  void flight.catch(() => { if (flights.get(name) === flight) flights.delete(name); });
  return flight;
}
