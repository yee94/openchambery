import { app, BrowserWindow, ipcMain, protocol, net } from 'electron';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImageDiskCache } from '../image-disk-cache.mjs';
import { createVirtualAssetRegistry, ASSET_SCHEME_PRIVILEGES } from '../virtual-asset-protocol.mjs';

const work = process.env.OC_IMAGE_EVIDENCE_DIR;
app.setPath('userData', join(work, 'profile'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'openchamber-asset', privileges: ASSET_SCHEME_PRIVILEGES },
  { scheme: 'openchamber-ui', privileges: ASSET_SCHEME_PRIVILEGES },
]);
app.whenReady().then(async () => {
const cache = createImageDiskCache({ directory: join(work, 'images') });
const streams = createVirtualAssetRegistry();
protocol.handle('openchamber-asset', (request) => new URL(request.url).hostname === 'cache' ? cache.handleRequest(request) : streams.handleRequest(request));
ipcMain.handle('cache:acquire', (event, input) => cache.acquire(event.sender.id, input));
ipcMain.handle('cache:append', (event, id, bytes) => cache.append(event.sender.id, id, bytes));
ipcMain.handle('cache:commit', (event, id, mime) => cache.commit(event.sender.id, id, mime));
ipcMain.handle('cache:release', (event, id) => cache.release(event.sender.id, id));
ipcMain.handle('stream:create', (_event, input) => streams.create(input));
ipcMain.handle('stream:push', (_event, id, bytes) => streams.push(id, bytes));
ipcMain.handle('stream:finish', (_event, id) => streams.finish(id));
ipcMain.handle('stream:cancel', (_event, id) => streams.cancel(id));
const png = await readFile(join(work, 'image.png'));
let downloads = 0, bytes = 0, stats = 0;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://test');
  if (url.pathname === '/stat') {
    stats++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ isFile: true, size: png.length, mtimeMs: 1 })); return;
  }
  if (url.pathname === '/api/fs/raw') {
    downloads++; response.setHeader('Content-Type', 'image/png');
    await new Promise((resolve) => setTimeout(resolve, 40));
    for (let offset = 0; offset < png.length && !response.destroyed; offset += 64 * 1024) {
      const chunk = png.subarray(offset, offset + 64 * 1024);
      bytes += chunk.length; response.write(chunk);
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    response.end(); return;
  }
  if (url.pathname === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(join(work, 'fixture.js'))); return; }
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script src="/fixture.js"></script></body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
protocol.handle('openchamber-ui', (request) => net.fetch(`http://127.0.0.1:${server.address().port}${new URL(request.url).pathname}`));
const window = new BrowserWindow({ show: true, width: 800, height: 600, webPreferences: {
  preload: join(dirname(fileURLToPath(import.meta.url)), 'image-cache-evidence.preload.cjs'),
  contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
} });
try {
  await window.loadURL(`http://127.0.0.1:${server.address().port}`);
  const results = { imageBytes: png.length, imageCount: 4, delayPer64KiBMs: 12, requestDelayMs: 40 };
  for (const cached of [false, true]) {
    downloads = 0; bytes = 0; stats = 0;
    const timing = await window.webContents.executeJavaScript(`window.runImageBenchmark(${cached})`);
    results[cached ? 'cached' : 'baseline'] = { ...timing, downloads, bytes, stats };
  }
  results.disk = await cache.stats();
  downloads = 0; bytes = 0; stats = 0;
  await window.loadURL('openchamber-ui://app/index.html');
  results.packaged = { ...await window.webContents.executeJavaScript('window.runImageBenchmark(true)'), downloads, bytes, stats };
  await writeFile(join(work, 'result.json'), JSON.stringify(results, null, 2));
} finally { window.destroy(); server.close(); app.quit(); }
}).catch((error) => { console.error(error); app.exit(1); });
