import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuiPluginMainHost } from '../gui-plugin-host.mjs';

const directory = process.env.YURI_TEST_EVIDENCE_DIR;
const mode = process.env.YURI_GUI_TEST_MODE;
app.setPath('userData', path.join(directory, `profile-${mode}`));
protocol.registerSchemesAsPrivileged([{ scheme: 'yuri-ui', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const source = `
  const {Plugin,Ipc,Command}=require('@opencode/plugin/gui');
  const {Schema}=require('effect');
  const {BrowserWindow}=require('electron');
  const Export=Ipc.define({id:'pdf-fixture.export',methods:{pdf:{input:Schema.String,output:Schema.String}}});
  module.exports=Plugin.define({
    setup(ctx){
      if(ctx.app.platform!=='desktop'||!ctx.desktop.os) throw new Error('Desktop metadata missing');
      const api=ctx.main(Export);
      ctx.add(Command,{id:'export',title:'Export',run:async()=>{
        const pdf=await api.pdf('<html><body><h1>Native plugin PDF</h1><p>Selectable text</p></body></html>');
        document.documentElement.dataset.pdf=pdf;
      }});
    },
    main(ctx){
      const live=new Set();
      ctx.onCleanup(()=>{for(const win of live)win.destroy()});
      ctx.provide(Export,{pdf:async(html,caller)=>{
        if(!ctx.windows.get(caller.window))throw new Error('Invalid calling window');
        const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
        live.add(win);
        try{
          await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
          const bytes=await win.webContents.printToPDF({printBackground:true,pageSize:'A4'});
          return bytes.toString('base64');
        }finally{live.delete(win);win.destroy()}
      }});
    }
  });
`;
let host;
app.whenReady().then(async () => {
try {
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.process={env:{NODE_ENV:"production"}}</script><script type="module" src="/fixture.js"></script></body></html>';
  const script = await readFile(path.join(directory, 'fixture.js'));
  let origin = 'yuri-ui://app';
  if (mode === 'hmr') {
    origin = process.env.YURI_GUI_TEST_ORIGIN;
  } else protocol.handle('yuri-ui', (request) => new Response(request.url.endsWith('fixture.js') ? script : html, {
    headers: { 'Content-Type': request.url.endsWith('fixture.js') ? 'text/javascript' : 'text/html' },
  }));
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: fileURLToPath(new URL('../preload.mjs', import.meta.url)), sandbox: false, contextIsolation: true, nodeIntegration: false,
    additionalArguments: [`--yuri-local-origin=${origin}`, '--yuri-packaged=0'],
  } });
  window.webContents.on('console-message', (event) => console.error(event.message));
  host = createGuiPluginMainHost({
    app, windows: BrowserWindow,
    getClient: () => ({ plugin: {
      list: async () => ({ data: [{ id: 'pdf-fixture', features: { gui: true }, state: { status: 'active' } }] }),
      gui: async () => ({ data: { code: source, revision: '1', options: {} } }),
    } }),
    authorize: (event) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
      && window.webContents.getURL().startsWith(`${origin}/`),
    send: (contents, payload) => contents.send('yuri:gui-plugin:event', payload),
  });
  ipcMain.handle('yuri:gui-plugin', (event, action, input) => host.dispatch(event, action, input));
  await window.loadURL(`${origin}/`);
  const result = await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const until=Date.now()+20000;
    const timer=setInterval(()=>{
      if(document.documentElement.dataset.finished){clearInterval(timer);resolve(document.documentElement.dataset.pdf)}
      else if(Date.now()>until){clearInterval(timer);reject(new Error('PDF fixture timed out'))}
    },25);
  })`);
  const pdf = Buffer.from(result, 'base64');
  if (pdf.subarray(0, 5).toString() !== '%PDF-' || pdf.length < 1000) throw new Error('Invalid PDF output');
  await writeFile(path.join(directory, `${mode}.pdf`), pdf);
  await host.dispose();
  window.destroy();
  app.exit(0);
} catch (error) {
  console.error(error);
  await host?.dispose();
  app.exit(1);
}
});
