import { app, BrowserWindow, protocol, net } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DesktopOta } from '../desktop-ota.mjs';
import { loadDesktopBackend } from '../desktop-backend.mjs';
import { desktopOtaEvidenceArgs } from './desktop-ota-evidence-launch.mjs';

const [root, stage = 'download'] = process.argv.slice(2);
app.setPath('userData', path.join(root, 'user-data'));
protocol.registerSchemesAsPrivileged([{ scheme: 'openchamber-ui', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.whenReady().then(async () => {
try {
  const decision = JSON.parse(await readFile(path.join(root, 'decision.json'), 'utf8'));
  const ota = new DesktopOta({ directory: path.join(root, 'ota'), builtinDirectory: path.join(root, 'builtin'),
    nativeVersion: '2.1.0', requireBackend: true, fetchImpl: async (url) => String(url).includes('/check')
      ? Response.json(decision) : new Response(await readFile(path.join(root, 'bundle.zip'))) });
  await ota.initialize();
  if (stage === 'download') {
    await ota.check('beta');
    await ota.download();
    await ota.assertPending();
    await writeFile(path.join(root, 'shutdown.json'), JSON.stringify({ pid: process.pid, version: ota.version }));
    app.relaunch({ args: desktopOtaEvidenceArgs({ script: process.argv[1], root, stage: 'apply' }) });
    app.exit(0);
  } else {
    const backend = await loadDesktopBackend(ota.backendDirectory);
    const server = await backend.startWebUiServer();
    const { openchamberVersion: backendVersion } = await (await fetch(`http://127.0.0.1:${server.getPort()}/api/system/info`)).json();
    protocol.handle('openchamber-ui', (request) => {
      const relative = new URL(request.url).pathname.replace(/^\//, '');
      return net.fetch(pathToFileURL(path.join(ota.assetDirectory, relative)).href);
    });
    const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await window.loadURL('openchamber-ui://app/index.html');
    const rendered = await window.webContents.executeJavaScript('document.body.textContent');
    await ota.ready(ota.version);
    const before = JSON.parse(await readFile(path.join(root, 'shutdown.json'), 'utf8'));
    await writeFile(path.join(root, 'result.json'), JSON.stringify({ before, pid: process.pid, version: ota.version, backendVersion, rendered, trial: ota.state.trial }));
    await server.stop();
    window.destroy();
    app.exit(0);
  }
} catch (error) {
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ error: error.stack }));
  app.exit(1);
}
});
