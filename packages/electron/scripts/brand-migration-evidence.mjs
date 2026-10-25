import { app, BrowserWindow, protocol, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { LEGACY_UI_PROTOCOL, prepareDesktopMigration, migrateDesktopOrigin } from '../brand-migration.mjs';

const [root, mode] = process.argv.slice(process.argv.indexOf('--') + 1);
const legacy = path.join(root, 'OpenChamber');
const current = path.join(root, 'Yuri');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('headless');
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
app.setPath('userData', mode === 'seed' ? legacy : current);
if (!app.requestSingleInstanceLock()) throw new Error('Fixture profile is already open');
protocol.registerSchemesAsPrivileged([LEGACY_UI_PROTOCOL, 'yuri-ui'].map((scheme) => ({ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true } })));
// The preceding fixture process has exited; unrelated installed apps do not own this temporary profile.
const plan = ['interrupt', 'migrate', 'verify'].includes(mode) ? prepareDesktopMigration({ appData: root, userData: current, profile: 'release', verifySourceClosed() {} }) : null;
app.whenReady().then(async () => {
  console.log(`Yuri migration fixture ready: ${mode}`);
  if (mode === 'interrupt') {
    class InterruptedWindow extends BrowserWindow {
      constructor(options) {
        super(options);
        const execute = this.webContents.executeJavaScript.bind(this.webContents);
        this.webContents.executeJavaScript = async (script, ...args) => {
          const result = await execute(script, ...args);
          if (script.startsWith('migration.insert(')) throw new Error('Injected interruption after committed record');
          return result;
        };
      }
    }
    await assert.rejects(migrateDesktopOrigin(plan, { BrowserWindow: InterruptedWindow, session }), /Injected interruption/);
    assert.equal(fs.existsSync(plan.marker), false);
    session.defaultSession.flushStorageData();
    console.log('Yuri migration interrupted after a committed record; receipt absent, source preserved');
    app.exit(0);
    return;
  }
  if (mode === 'migrate') await migrateDesktopOrigin(plan, { BrowserWindow, session });
  const scheme = mode === 'seed' ? LEGACY_UI_PROTOCOL : 'yuri-ui';
  protocol.handle(scheme, () => new Response('<!doctype html><title>Migration fixture</title>', { headers: { 'content-type': 'text/html' } }));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, offscreen: true } });
  await window.loadURL(`${scheme}://app/`);
  console.log(`Yuri migration fixture loaded: ${mode}`);
  if (mode === 'seed' || mode === 'target') {
    await window.webContents.executeJavaScript(`(async () => {
      const seed = ${mode === 'seed'};
      for (const kind of ['higher', 'deleted']) {
        const req = indexedDB.open((seed ? 'openchamber' : 'yuri') + '-' + kind, !seed && kind === 'higher' ? 4 : 3);
        req.onupgradeneeded = () => req.result.createObjectStore('rows');
        const db = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
        const tx = db.transaction('rows', 'readwrite');
        if (seed || kind === 'higher') tx.objectStore('rows').put(seed ? 'old' : 'new', 'record');
        else { tx.objectStore('rows').put('user-deleted', 'record'); tx.objectStore('rows').delete('record'); }
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
        db.close();
      }
    })()`);
  }
  if (mode === 'seed') {
    await window.webContents.executeJavaScript(`(async () => {
      localStorage.setItem('openchamber-settings', JSON.stringify({ text: 'user OpenChamber text stays unchanged' }));
      localStorage.setItem('openchamber-projects:https%3A%2F%2Fopenchamber.example', 'url-scope');
      localStorage.setItem('oc.rt.b3BlbmNoYW1iZXI.openchamber-projects:opaque-openchamber', 'opaque-scope');
      const req = indexedDB.open('openchamber-drafts', 3);
      req.onupgradeneeded = () => { const store = req.result.createObjectStore('drafts', { keyPath: 'id' }); store.createIndex('session', 'session'); };
      const db = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').put({ id: 'draft', session: 'session-1', text: 'unsent draft', attachment: new Blob([new Uint8Array([0, 255, 42])], { type: 'image/png' }), transcript: { parts: [{ text: 'persisted transcript' }] }, date: new Date('2026-01-01') });
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      db.close();
    })()`);
  } else if (mode !== 'target') {
    const result = await window.webContents.executeJavaScript(`(async () => {
      const req = indexedDB.open('yuri-drafts');
      const db = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      const get = db.transaction('drafts').objectStore('drafts').get('draft');
      const row = await new Promise((resolve, reject) => { get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); });
      const result = { version: db.version, text: row.text, bytes: [...new Uint8Array(await row.attachment.arrayBuffer())], mime: row.attachment.type, transcript: row.transcript.parts[0].text, date: row.date.toISOString(), settings: localStorage.getItem('yuri-settings') };
      db.close();
      return result;
    })()`);
    assert.equal(result.version, 3);
    assert.equal(result.text, 'unsent draft');
    assert.deepEqual(result.bytes, [0, 255, 42]);
    assert.equal(result.mime, 'image/png');
    assert.equal(result.transcript, 'persisted transcript');
    assert.equal(result.date, '2026-01-01T00:00:00.000Z');
    assert.match(result.settings, /user OpenChamber text stays unchanged/);
    const precedence = await window.webContents.executeJavaScript(`(async () => {
      const result = {};
      for (const kind of ['higher', 'deleted']) {
        const req = indexedDB.open('yuri-' + kind);
        const db = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
        const get = db.transaction('rows').objectStore('rows').get('record');
        result[kind] = { version: db.version, value: await new Promise((resolve, reject) => { get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); }) };
        db.close();
      }
      result.url = localStorage.getItem('yuri-projects:https%3A%2F%2Fopenchamber.example');
      result.opaque = localStorage.getItem('yuri.rt.b3BlbmNoYW1iZXI.yuri-projects:opaque-openchamber');
      return result;
    })()`);
    assert.equal(precedence.higher.version, 4);
    assert.equal(precedence.higher.value, 'new');
    assert.equal(precedence.deleted.value, undefined);
    assert.equal(precedence.url, 'url-scope');
    assert.equal(precedence.opaque, 'opaque-scope');
    assert.ok(fs.existsSync(path.join(legacy, 'IndexedDB')));
    assert.equal(prepareDesktopMigration({ appData: root, userData: current, profile: 'release' }), null);
    console.log('Yuri origin migration: draft, Blob, transcript, higher-version precedence, no deleted-row resurrection, opaque scopes and repeat-start verified');
  }
  session.defaultSession.flushStorageData();
  window.destroy();
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
