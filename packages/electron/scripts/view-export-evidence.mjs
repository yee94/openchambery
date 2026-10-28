import { app, BrowserWindow, ipcMain, protocol, session, nativeImage } from 'electron';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createViewExportHost, isViewExportSender } from '../view-export.mjs';
import { createGuiPluginMainHost } from '../gui-plugin-host.mjs';

const directory = process.env.YURI_TEST_EVIDENCE_DIR;
const mode = process.env.YURI_EXPORT_TEST_MODE;
app.setPath('userData', path.join(directory, `profile-${mode}`));
app.commandLine.appendSwitch('force-color-profile', 'srgb');
protocol.registerSchemesAsPrivileged([{ scheme: 'yuri-ui', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let host;
let guiHost;
app.whenReady().then(async () => {
  try {
    const origin = mode === 'hmr' ? process.env.YURI_EXPORT_TEST_ORIGIN : 'yuri-ui://app';
    if (mode !== 'hmr') protocol.handle('yuri-ui', () => new Response('<!doctype html><html><body>Export fixture</body></html>', { headers: { 'Content-Type': 'text/html' } }));
    const owner = new BrowserWindow({ show: false, webPreferences: {
      preload: fileURLToPath(new URL('../preload.mjs', import.meta.url)), sandbox: false, contextIsolation: true, nodeIntegration: false,
      additionalArguments: [`--yuri-local-origin=${origin}`, '--yuri-packaged=0'],
    } });
    owner.__yuriRuntimeConfig = { relayHostId: 'fixture-remote-runtime' };
    let chooseCancel = false;
    let progressHook = () => {};
    let ownerEvent;
    host = createViewExportHost({ BrowserWindow, session,
      dialog: { showSaveDialog: async (_parent, options) => chooseCancel ? { canceled: true } : { filePath: path.join(directory, `${mode}-${options.defaultPath}`) } },
      authorize: (event) => isViewExportSender(event, BrowserWindow, [origin]),
      send: (contents, event) => { contents.send('yuri:view-export:event', event); progressHook(event); },
    });
    ipcMain.handle('yuri:view-export', (event, method, input) => { ownerEvent = event; return host.dispatch(event, method, input); });
    guiHost = createGuiPluginMainHost({ app, windows: BrowserWindow,
      getClient: () => { throw new Error('Export must never execute plugin main'); },
      authorizeWindow: (event) => isViewExportSender(event, BrowserWindow, [origin]),
      authorize: (event) => isViewExportSender(event, BrowserWindow, [origin]) && !owner.__yuriRuntimeConfig.relayHostId && !guiHost.isWindowOnly(event.sender),
      send: (contents, event) => contents.send('yuri:gui-plugin:event', event),
    });
    ipcMain.handle('yuri:gui-plugin', (event, method, input) => guiHost.dispatch(event, method, input));
    await owner.loadURL(`${origin}/`);
    const invoke = (method, input) => owner.webContents.executeJavaScript(`window.__YURI_DESKTOP__.viewExport.request(${JSON.stringify(method)}, ${JSON.stringify(input)})`);
    const caps = await invoke('capabilities');
    assert.equal(caps.value.exportPDF, true);
    assert.equal(caps.value.exportLongImage, true);
    const windowOnly = await owner.webContents.executeJavaScript('window.__YURI_DESKTOP__.guiPlugins.request("window-only")');
    assert.equal(windowOnly.ok, true);
    const forbiddenMain = await owner.webContents.executeJavaScript('window.__YURI_DESKTOP__.guiPlugins.request("acquire", {id:"fixture",revision:"1"})');
    assert.equal(forbiddenMain.error.code, 'GUI_PLUGIN_DOCUMENT_RESTRICTED');
    await owner.webContents.executeJavaScript('window.exportEvents=[]; window.unsubscribeExport=window.__YURI_DESKTOP__.viewExport.subscribe(e=>window.exportEvents.push(e));true');
    const snapshot = { width: 600, height: 4000, html: `<div style="height:4000px;background:#ff0000;position:relative"><h1>Selectable report text</h1><div style="position:absolute;bottom:0;height:100px;width:600px;background:#0000ff">END OF REPORT</div></div>
      <script>document.body.innerHTML='SCRIPT EXECUTED';fetch('${origin}/leak')</script>
      <img src="${origin}/network-probe"><iframe src="${origin}/frame-probe"></iframe>` };
    for (const [method, filename, pageSize] of [['exportPDF', 'a4', 'a4'], ['exportPDF', 'letter', 'letter'], ['exportLongImage', 'long']]) {
      const result = await invoke(method, { taskId: filename, filename, snapshot, ...(pageSize ? { pageSize } : {}) });
      assert.deepEqual(result, { ok: true, value: { status: 'saved' } });
    }
    const png = nativeImage.createFromBuffer(await readFile(path.join(directory, `${mode}-long.png`)));
    assert.deepEqual(png.getSize(), { width: 600, height: 4000 });
    const bitmap = png.toBitmap();
    const bottom = (3990 * 600 + 590) * 4;
    // NativeImage bitmap decoding may convert sRGB into the display color space.
    assert.ok(bitmap[bottom] > 200 && bitmap[bottom + 1] < 80 && bitmap[bottom + 2] < 80 && bitmap[bottom + 3] === 255);
    const pages = {};
    for (const size of ['a4', 'letter']) {
      const pdf = await readFile(path.join(directory, `${mode}-${size}.pdf`));
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
      pages[size] = [...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length;
      assert.ok(pages[size] >= 3, `Expected paginated ${size}: ${pages[size]}`);
      const media = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(pdf.toString('latin1'));
      assert.ok(media, 'PDF needs an explicit paper size');
      assert.ok(Math.abs(Number(media[1]) - (size === 'letter' ? 612 : 595)) < 2);
      assert.ok(Math.abs(Number(media[2]) - (size === 'letter' ? 792 : 842)) < 2);
    }
    const tall = await invoke('exportLongImage', { taskId: 'tall', filename: 'tall', snapshot: {
      width: 320, height: 32768, html: '<div style="height:32768px;background:linear-gradient(red,blue)">Maximum declared height</div>',
    } });
    assert.equal(tall.value.status, 'saved');
    assert.deepEqual(nativeImage.createFromBuffer(await readFile(path.join(directory, `${mode}-tall.png`))).getSize(), { width: 320, height: 32768 });
    await owner.webContents.executeJavaScript(`window.cancelExportListener=window.__YURI_DESKTOP__.viewExport.subscribe(e=>{
      if(e.taskId==='cancel-render' && e.stage==='rendering') void window.__YURI_DESKTOP__.viewExport.request('cancel',{taskId:e.taskId});
    });true`);
    assert.equal((await invoke('exportPDF', { taskId: 'cancel-render', filename: 'cancel-render', snapshot })).value.status, 'cancelled');
    await owner.webContents.executeJavaScript('window.cancelExportListener();true');
    chooseCancel = true;
    assert.equal((await invoke('exportPDF', { taskId: 'cancel-picker', filename: 'cancelled', snapshot })).value.status, 'cancelled');
    const stages = await owner.webContents.executeJavaScript('window.unsubscribeExport();window.exportEvents');
    assert.deepEqual(stages.filter((e) => e.taskId === 'long').map((e) => e.stage), ['preparing', 'rendering', 'encoding', 'saving']);
    let navigation;
    progressHook = (event) => { if (event.taskId === 'navigate' && event.stage === 'rendering') navigation = owner.loadURL(`${origin}/new`); };
    const navigated = await host.dispatch(ownerEvent, 'exportPDF', { taskId: 'navigate', filename: 'navigate', snapshot });
    assert.equal(navigated.value.status, 'cancelled');
    await navigation;
    progressHook = () => {};
    await owner.loadURL(`${origin}/api/fs/raw`);
    assert.equal((await invoke('capabilities')).error.code, 'EXPORT_FORBIDDEN');
    await owner.loadURL(`${origin}/preview.html`);
    assert.equal((await invoke('capabilities')).error.code, 'EXPORT_FORBIDDEN');
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
    await writeFile(path.join(directory, `${mode}-result.json`), JSON.stringify({ mode, pages, png: png.getSize(), bottomPixel: [...bitmap.subarray(bottom, bottom + 4)], stages, isolatedWindowsRemaining: 0 }, null, 2));
    await host.dispose();
    await guiHost.dispose();
    owner.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await host?.dispose();
    await guiHost?.dispose();
    app.exit(1);
  }
});
