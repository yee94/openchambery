import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// These identities are read-only migration inputs, never runtime defaults.
export const LEGACY_UI_PROTOCOL = 'openchamber-ui';
const LEGACY_NAMES = ['OpenChamber', 'OpenChamberY'];
const MARKER = 'yuri-desktop-migration-v1.json';

function exists(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Desktop migration refuses symbolic links.');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertLegacyStopped() {
  const commands = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | Select-Object -ExpandProperty ProcessName'], { encoding: 'utf8', windowsHide: true })
    : execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8' });
  if (commands.split('\n').some((line) => /(?:^|[/\\])openchamber(?:y)?(?:[ -](?:preview|prev|dev))?(?:\.exe|\.app(?:[/\\].*)?)?$/i.test(line.trim()))) {
    throw new Error('Close the previous desktop application before importing its data, then restart Yuri.');
  }
}

function copyTree(source, target) {
  fs.cpSync(source, target, {
    recursive: true, errorOnExist: true, force: false,
    filter: (entry) => {
      if (fs.lstatSync(entry).isSymbolicLink()) throw new Error('Desktop migration refuses symbolic links.');
      return true;
    },
  });
}

/** Runs before any storage owner opens the new profile. Existing Yuri data wins. */
export function prepareDesktopMigration({ appData, userData, profile, verifySourceClosed = assertLegacyStopped, migrateHostData }) {
  const marker = path.join(userData, MARKER);
  if (exists(marker)) {
    const result = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (result.version !== 1 || result.complete !== true) throw new Error('Invalid desktop migration receipt.');
    return null;
  }
  const suffix = profile === 'dev' ? ' Dev' : profile === 'preview' ? ' Preview' : '';
  const sources = LEGACY_NAMES.map((name) => path.join(appData, name + suffix)).filter(exists);
  if (!sources.length) return null;
  if (sources.length > 1) throw new Error('Multiple previous desktop profiles found. Keep one import source and restart Yuri.');
  verifySourceClosed();
  const source = sources[0];
  const hostSource = path.join(source, 'openchamber-data');
  if (exists(hostSource)) {
    if (!migrateHostData) throw new Error('This previous profile contains isolated Host data. A profile-aware Host importer is required before Yuri can open it.');
    migrateHostData({ sourceRoot: hostSource, targetRoot: path.join(userData, 'yuri-data') });
  }
  fs.mkdirSync(userData, { recursive: true });
  const snapshot = path.join(userData, 'migration-source-v1');
  const staging = `${snapshot}.partial`;
  if (!exists(snapshot)) {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging);
    try {
      for (const name of ['Local Storage', 'IndexedDB']) {
        if (exists(path.join(source, name))) copyTree(path.join(source, name), path.join(staging, name));
      }
      verifySourceClosed();
      fs.renameSync(staging, snapshot);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  for (const name of ['session-index.sqlite', 'message-queue.sqlite', 'transcript-cache.sqlite']) {
    const oldFile = path.join(source, name);
    const newFile = path.join(userData, name);
    if (!exists(oldFile) || exists(newFile)) continue;
    const temporary = `${newFile}.migration`;
    fs.rmSync(temporary, { force: true });
    const db = new DatabaseSync(oldFile, { readOnly: true });
    try {
      if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Previous desktop database is corrupt.');
      db.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
      fs.renameSync(temporary, newFile);
    } finally { db.close(); }
  }
  const oldImages = path.join(source, 'image-cache-v1');
  const newImages = path.join(userData, 'image-cache-v1');
  if (exists(oldImages) && !exists(newImages)) {
    const temporary = `${newImages}.migration`;
    fs.rmSync(temporary, { recursive: true, force: true });
    copyTree(oldImages, temporary);
    fs.renameSync(temporary, newImages);
  }
  return { snapshot, marker };
}

// Executed only in isolated, preload-free migration windows. Values are encoded
// by type so Blob attachments, binary keys and dates survive Electron IPC.
function migrationRenderer() {
  const request = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Migration database blocked'));
  });
  const renameNamespace = (name) => {
    for (const brand of ['openchambery', 'openchamber']) {
      if (name === brand || name.startsWith(`${brand}.`) || name.startsWith(`${brand}_`) || name.startsWith(`${brand}-`)) return `yuri${name.slice(brand.length)}`;
    }
    if (/^oc[.:-]/.test(name)) return `yuri${name.slice(2)}`;
    return name;
  };
  const renamedStorageKey = (key) => {
    const scoped = /^(oc|yuri)\.(rt|inst)\.([^.]+)\.(.*)$/.exec(key);
    return scoped ? `yuri.${scoped[2]}.${scoped[3]}.${renameNamespace(scoped[4])}` : renameNamespace(key);
  };
  const markerStore = '__yuri_desktop_brand_migration';
  const encode = async (value) => {
    if (value === undefined) return ['undefined'];
    if (typeof value === 'number' && !Number.isFinite(value)) return ['number', String(value)];
    if (typeof value === 'bigint') return ['bigint', String(value)];
    if (value instanceof Date) return ['date', value.toISOString()];
    if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value instanceof Blob ? await value.arrayBuffer() : value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      if (bytes.length > 64 * 1024 * 1024) throw new Error('Migration record exceeds 64 MiB');
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return [value instanceof File ? 'file' : value instanceof Blob ? 'blob' : value instanceof ArrayBuffer ? 'buffer' : value.constructor.name, btoa(binary), value instanceof File ? { type: value.type, name: value.name, lastModified: value.lastModified } : value.type || ''];
    }
    if (value instanceof Map) return ['map', await Promise.all([...value].map(async ([k, v]) => [await encode(k), await encode(v)]))];
    if (value instanceof Set) return ['set', await Promise.all([...value].map(encode))];
    if (Array.isArray(value)) return ['array', await Promise.all(value.map(encode))];
    if (value !== null && typeof value === 'object') {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Unsupported migration value; source preserved');
      return ['object', await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await encode(v)]))];
    }
    return ['value', value];
  };
  const decode = ([type, value, mime]) => {
    if (type === 'undefined') return undefined;
    if (type === 'number') return Number(value);
    if (type === 'bigint') return BigInt(value);
    if (type === 'date') return new Date(value);
    if (type === 'array') return value.map(decode);
    if (type === 'object') return Object.fromEntries(value.map(([k, v]) => [k, decode(v)]));
    if (type === 'map') return new Map(value.map(([k, v]) => [decode(k), decode(v)]));
    if (type === 'set') return new Set(value.map(decode));
    if (type === 'value') return value;
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    if (type === 'blob') return new Blob([bytes], { type: mime });
    if (type === 'file') return new File([bytes], mime.name, { type: mime.type, lastModified: mime.lastModified });
    if (type === 'buffer') return bytes.buffer;
    const constructors = { Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
    if (!constructors[type]) throw new Error('Unsupported migration value type');
    return new constructors[type](bytes.buffer);
  };
  let database;
  globalThis.migration = {
    local: () => Object.entries(localStorage),
    importLocal: (entries) => {
      for (const [key, value] of entries) {
        const target = renamedStorageKey(key);
        const marker = `yuri.migration.storage.${encodeURIComponent(target)}`;
        if (localStorage.getItem(marker) === '1') continue;
        if (localStorage.getItem(target) === null) localStorage.setItem(target, value);
        localStorage.setItem(marker, '1');
      }
    },
    databases: () => indexedDB.databases(),
    open: async (name) => {
      database?.close();
      database = await request(indexedDB.open(name));
      return { name, version: database.version, stores: [...database.objectStoreNames].map((name) => {
        const store = database.transaction(name).objectStore(name);
        return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: [...store.indexNames].map((indexName) => {
          const index = store.index(indexName);
          return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
        }) };
      }) };
    },
    create: async (schema) => {
      database?.close();
      const target = renameNamespace(schema.name);
      const existing = (await indexedDB.databases()).find((entry) => entry.name === target);
      const req = existing ? indexedDB.open(target) : indexedDB.open(target, schema.version);
      req.onupgradeneeded = () => {
        if (schema.stores.some((entry) => entry.name === markerStore)) { req.transaction.abort(); return; }
        for (const entry of schema.stores) {
          if (req.result.objectStoreNames.contains(entry.name)) continue;
          const store = req.result.createObjectStore(entry.name, { keyPath: entry.keyPath, autoIncrement: entry.autoIncrement });
          for (const index of entry.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        }
        req.result.createObjectStore(markerStore).put(schema.name, 'source');
      };
      database = await request(req);
      // A pre-existing Yuri database is authoritative, including its deletions
      // and newer schema. Only databases atomically marked as ours may resume.
      if (!database.objectStoreNames.contains(markerStore)) return false;
      const marker = database.transaction(markerStore).objectStore(markerStore);
      const sourceRequest = marker.get('source');
      const completeRequest = marker.get('complete');
      const [source, complete] = await Promise.all([request(sourceRequest), request(completeRequest)]);
      if (source !== schema.name || complete === true) return false;
      if (database.version !== schema.version) throw new Error('Incomplete desktop migration schema changed');
      return true;
    },
    complete: () => new Promise((resolve, reject) => {
      const transaction = database.transaction(markerStore, 'readwrite');
      transaction.objectStore(markerStore).put(true, 'complete');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('Migration receipt transaction aborted'));
    }),
    next: async (store, after) => {
      const cursor = await request(database.transaction(store).objectStore(store).openCursor(after ? IDBKeyRange.lowerBound(decode(after), true) : undefined));
      return cursor ? { key: await encode(cursor.primaryKey), value: await encode(cursor.value) } : null;
    },
    insert: (name, entry) => new Promise((resolve, reject) => {
      const transaction = database.transaction(name, 'readwrite');
      const store = transaction.objectStore(name);
      const key = decode(entry.key);
      const check = store.count(key);
      check.onsuccess = () => {
        if (!check.result) {
          const value = decode(entry.value);
          if (store.keyPath === null) store.add(value, key); else store.add(value);
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('Migration transaction aborted'));
      transaction.onerror = () => reject(transaction.error);
    }),
    close: () => database?.close(),
  };
}

/** No app UI/preload runs until import commits. Old origin is never privileged. */
export async function migrateDesktopOrigin(plan, { BrowserWindow, session }) {
  if (!plan) return;
  const sourceSession = session.fromPath(plan.snapshot, { cache: false });
  const targetSession = session.defaultSession;
  const page = (req) => req.url === 'openchamber-ui://app/' || req.url === 'yuri-ui://app/'
    ? new Response('<!doctype html><title>Yuri data import</title>', { headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'" } })
    : new Response('', { status: 403 });
  sourceSession.protocol.handle(LEGACY_UI_PROTOCOL, page);
  targetSession.protocol.handle('yuri-ui', page);
  const windows = [sourceSession, targetSession].map((ses) => new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } }));
  const call = (window, method, ...args) => window.webContents.executeJavaScript(`migration.${method}(...${JSON.stringify(args)})`);
  try {
    await Promise.all(windows.map((window, index) => window.loadURL(index ? 'yuri-ui://app/' : 'openchamber-ui://app/')));
    await Promise.all(windows.map((window) => window.webContents.executeJavaScript(`(${migrationRenderer.toString()})()`)));
    const [source, target] = windows;
    const local = await call(source, 'local');
    if (Buffer.byteLength(JSON.stringify(local)) > 16 * 1024 * 1024) throw new Error('Desktop local storage import exceeds limit');
    await call(target, 'importLocal', local);
    let total = 0;
    let records = 0;
    const databases = await call(source, 'databases');
    if (databases.length > 64) throw new Error('Desktop database import exceeds limit');
    for (const { name } of databases) {
      const schema = await call(source, 'open', name);
      if (!await call(target, 'create', schema)) continue;
      for (const store of schema.stores) {
        let after;
        for (;;) {
          const record = await call(source, 'next', store.name, after);
          if (!record) break;
          const size = Buffer.byteLength(JSON.stringify(record));
          total += size;
          if (size > 96 * 1024 * 1024 || total > 1024 * 1024 * 1024 || ++records > 200_000) throw new Error('Desktop migration limit exceeded; source preserved.');
          await call(target, 'insert', store.name, record);
          after = record.key;
        }
      }
      await call(target, 'complete');
    }
    await Promise.all(windows.map((window) => call(window, 'close')));
    await targetSession.flushStorageData();
    const temporary = `${plan.marker}.partial`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, complete: true }), { mode: 0o600 });
    fs.renameSync(temporary, plan.marker);
  } finally {
    for (const window of windows) window.destroy();
    sourceSession.protocol.unhandle(LEGACY_UI_PROTOCOL);
    targetSession.protocol.unhandle('yuri-ui');
  }
}
