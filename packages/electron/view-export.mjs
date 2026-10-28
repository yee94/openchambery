import { randomUUID } from 'node:crypto';
import { writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isGuiPluginUiUrl } from './gui-plugin-origin.mjs';

export const VIEW_EXPORT_LIMITS = Object.freeze({
  maxHTMLBytes: 16 * 1024 * 1024, maxWidth: 8192, maxHeight: 32768, maxPixels: 16 * 1024 * 1024,
});

const failure = (code, message) => Object.assign(new Error(message), { code });
const cancelled = () => failure('EXPORT_ABORTED', 'Export cancelled');

export function isViewExportSender(event, windows, origins) {
  return Boolean(event.senderFrame && event.senderFrame === event.sender?.mainFrame
    && windows.fromWebContents(event.sender)
    && isGuiPluginUiUrl(event.sender.getURL(), origins)
    && event.senderFrame.url === event.sender.getURL());
}

function validate(method, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['snapshot', 'filename', 'taskId', ...(method === 'exportPDF' ? ['pageSize'] : [])].includes(key))
    || typeof input.taskId !== 'string' || !/^[\w-]{1,128}$/.test(input.taskId)
    || typeof input.filename !== 'string' || !input.filename.trim() || input.filename.length > 200
    || /[/\\\x00-\x1f<>:"|?*]/.test(input.filename) || /^\.+$/.test(input.filename)
    || (input.pageSize !== undefined && !['a4', 'letter'].includes(input.pageSize))) {
    throw failure('EXPORT_INVALID_INPUT', 'Invalid export request');
  }
  const snapshot = input.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || Object.keys(snapshot).some((key) => !['html', 'width', 'height'].includes(key))
    || typeof snapshot.html !== 'string' || !snapshot.html.trim()
    || !Number.isInteger(snapshot.width) || snapshot.width < 1
    || !Number.isInteger(snapshot.height) || snapshot.height < 1) {
    throw failure('EXPORT_INVALID_INPUT', 'Invalid static snapshot');
  }
  if (Buffer.byteLength(snapshot.html, 'utf8') > VIEW_EXPORT_LIMITS.maxHTMLBytes
    || snapshot.width > VIEW_EXPORT_LIMITS.maxWidth || snapshot.height > VIEW_EXPORT_LIMITS.maxHeight
    || snapshot.width * snapshot.height > VIEW_EXPORT_LIMITS.maxPixels) {
    throw failure('EXPORT_TOO_LARGE', 'Snapshot exceeds export limits');
  }
  return input;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** Container-owned export; no plugin main, runtime endpoint, or renderer path is accepted. */
export function createViewExportHost({ BrowserWindow, session, dialog, authorize, send,
  files = { writeFile, rename, rm }, timeoutMs = 60_000 }) {
  const tasks = new Map();
  const running = new Set();
  const pickers = new Map();
  let disposed = false;

  function stop(task, reason = cancelled()) {
    if (task.committing) return;
    task.controller.abort(reason);
    if (task.window && !task.window.isDestroyed()) task.window.destroy();
  }

  async function run(event, method, input) {
    const owner = event.sender;
    if (tasks.has(owner) || pickers.has(owner)) throw failure('EXPORT_BUSY', 'An export is already active');
    const task = { id: input.taskId, controller: new AbortController(), window: null, committing: false };
    tasks.set(owner, task);
    const { signal } = task.controller;
    const check = () => {
      signal.throwIfAborted();
      if (owner.isDestroyed() || !authorize(event)) throw cancelled();
    };
    const progress = (stage) => {
      check();
      send(owner, { taskId: input.taskId, stage });
    };
    const navigate = (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) stop(task); };
    const destroyed = () => stop(task);
    owner.on('did-start-navigation', navigate);
    owner.once('destroyed', destroyed);
    owner.once('render-process-gone', destroyed);
    let temporary;
    let isolated;
    let timer;
    let phase = 'render';
    try {
      progress('preparing');
      const { width, height, html } = input.snapshot;
      isolated = session.fromPartition(`view-export-${randomUUID()}`, { cache: false });
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolated.setPermissionCheckHandler(() => false);
      const url = 'https://snapshot.invalid/';
      const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-same-origin";
      isolated.protocol.handle('https', () => new Response('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp },
      }));
      isolated.webRequest.onBeforeRequest((details, callback) => callback({
        cancel: !(details.url === url && details.resourceType === 'mainFrame') && !details.url.startsWith('data:'),
      }));
      isolated.on('will-download', (downloadEvent) => downloadEvent.preventDefault());
      task.window = new BrowserWindow({ show: false, width: Math.min(width, 1200), height: 800,
        webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
          nodeIntegrationInWorker: false, javascript: false, webSecurity: true, webgl: false,
          plugins: false, backgroundThrottling: false, imageAnimationPolicy: 'noAnimation' },
      });
      const contents = task.window.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', (navigation) => navigation.preventDefault());
      contents.on('will-frame-navigate', (navigation) => navigation.preventDefault());
      contents.on('will-attach-webview', (attach) => attach.preventDefault());
      contents.once('render-process-gone', () => stop(task, failure('EXPORT_RENDER_FAILED', 'Export renderer stopped')));
      timer = setTimeout(() => stop(task, failure('EXPORT_RENDER_FAILED', 'Export rendering timed out')), timeoutMs);
      progress('rendering');
      await abortable(task.window.loadURL(url), signal);
      check();
      contents.debugger.attach('1.3');
      const command = (name, params) => abortable(contents.debugger.sendCommand(name, params), signal);
      await command('Emulation.setDeviceMetricsOverride', { width, height: Math.min(height, 800), deviceScaleFactor: 1, mobile: false });
      // Only fixed host programs execute; HTML is a CDP value, never source code.
      // Parse inertly first so disallowed frames cannot navigate or log their URLs.
      const context = await command('Runtime.evaluate', { expression: 'globalThis' });
      const readiness = await command('Runtime.callFunctionOn', { objectId: context.result.objectId,
        arguments: [{ value: html }, { value: width }, { value: height }], awaitPromise: true, returnByValue: true,
        functionDeclaration: `async function(html, width, height) {
        const template = document.createElement('template');
        template.innerHTML = html;
        for (const element of template.content.querySelectorAll('script,iframe,frame,object,embed,base,meta,link')) element.remove();
        document.body.replaceChildren(template.content);
        for (const root of [document.documentElement, document.body]) {
          root.removeAttribute('style');
          root.style.cssText = 'margin:0!important;padding:0!important;border:0!important;width:'+width+'px!important;max-width:'+width+'px!important;height:'+height+'px!important;max-height:'+height+'px!important;overflow:hidden!important;transform:none!important;zoom:1!important';
        }
        const style = document.createElement('style');
        style.textContent = '*{animation:none!important;transition:none!important}';
        document.head.append(style);
        await document.fonts.ready;
        await Promise.all(Array.from(document.images, image => image.decode().catch(() => {})));
        return true;
      }` });
      if (readiness.exceptionDetails) throw failure('EXPORT_RENDER_FAILED', 'Snapshot preparation failed');
      progress('encoding');
      let bytes;
      if (method === 'exportPDF') {
        const paperWidth = input.pageSize === 'letter' ? 816 : 793.7;
        await command('Runtime.evaluate', { expression: `document.documentElement.style.setProperty('zoom', '${Math.min(1, (paperWidth - 64) / width)}', 'important')` });
        bytes = await abortable(contents.printToPDF({ printBackground: true, pageSize: input.pageSize === 'letter' ? 'Letter' : 'A4',
          preferCSSPageSize: false, displayHeaderFooter: false, scale: 1,
          margins: { top: 1 / 3, bottom: 1 / 3, left: 1 / 3, right: 1 / 3 },
        }), signal);
      } else {
        const capture = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true,
          clip: { x: 0, y: 0, width, height, scale: 1 },
        });
        bytes = Buffer.from(capture.data, 'base64');
        if (bytes.length < 24 || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) {
          throw failure('EXPORT_RENDER_FAILED', 'Snapshot dimensions did not match');
        }
      }
      clearTimeout(timer);
      check();
      task.window.destroy();
      phase = 'save';
      progress('saving');
      const extension = method === 'exportPDF' ? 'pdf' : 'png';
      const filename = input.filename.replace(/\.(pdf|png)$/i, '') + `.${extension}`;
      // Electron has no save-dialog AbortSignal. Keep its owner reserved until the
      // chooser closes; cancellation discards its eventual result and frees render resources immediately.
      const picker = dialog.showSaveDialog(BrowserWindow.fromWebContents(owner), {
        defaultPath: filename, filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      });
      pickers.set(owner, picker);
      void picker.finally(() => { if (pickers.get(owner) === picker) pickers.delete(owner); }).catch(() => {});
      const choice = await abortable(picker, signal);
      check();
      if (choice.canceled || !choice.filePath) return { status: 'cancelled' };
      temporary = join(dirname(choice.filePath), `.yuri-export-${randomUUID()}.tmp`);
      await files.writeFile(temporary, bytes, { flag: 'wx', signal });
      check();
      // Atomic commit is the point of no return: a concurrent cancel cannot turn
      // an already committed destination into a false cancelled result.
      task.committing = true;
      await files.rename(temporary, choice.filePath);
      temporary = undefined;
      return { status: 'saved' };
    } catch (error) {
      if (signal.reason?.code === 'EXPORT_ABORTED' || error?.code === 'EXPORT_ABORTED') return { status: 'cancelled' };
      if (signal.reason) throw signal.reason;
      throw failure(phase === 'save' ? 'EXPORT_SAVE_FAILED' : 'EXPORT_RENDER_FAILED', phase === 'save' ? 'Unable to save export' : 'Unable to render snapshot');
    } finally {
      clearTimeout(timer);
      owner.removeListener('did-start-navigation', navigate);
      owner.removeListener('destroyed', destroyed);
      owner.removeListener('render-process-gone', destroyed);
      if (task.window && !task.window.isDestroyed()) task.window.destroy();
      if (isolated) {
        isolated.protocol.unhandle('https');
        isolated.webRequest.onBeforeRequest(null);
        await isolated.clearStorageData().catch(() => {});
      }
      if (temporary) await files.rm(temporary, { force: true }).catch(() => {});
      if (tasks.get(owner) === task) tasks.delete(owner);
    }
  }

  return {
    async dispatch(event, method, input) {
      try {
        if (disposed || !authorize(event)) throw failure('EXPORT_FORBIDDEN', 'Export is unavailable for this document');
        if (method === 'capabilities') return { ok: true, value: { version: 1, exportPDF: true, exportLongImage: true, limits: VIEW_EXPORT_LIMITS } };
        if (method === 'cancel') {
          if (!input || typeof input.taskId !== 'string' || !/^[\w-]{1,128}$/.test(input.taskId)) throw failure('EXPORT_INVALID_INPUT', 'Invalid export task');
          const task = tasks.get(event.sender);
          if (task?.id === input.taskId) stop(task);
          return { ok: true, value: { status: 'cancelled' } };
        }
        if (!['exportPDF', 'exportLongImage'].includes(method)) throw failure('EXPORT_UNSUPPORTED', 'Unknown export method');
        const work = run(event, method, validate(method, input));
        running.add(work);
        try { return { ok: true, value: await work }; }
        finally { running.delete(work); }
      } catch (error) {
        return { ok: false, error: { code: error.code || 'EXPORT_RENDER_FAILED', message: error.message || 'Export failed' } };
      }
    },
    invalidateOwner(owner) { const task = tasks.get(owner); if (task) stop(task); },
    async dispose() {
      disposed = true;
      for (const task of tasks.values()) stop(task);
      await Promise.allSettled([...running]);
    },
  };
}
