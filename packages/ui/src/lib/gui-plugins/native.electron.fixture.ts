import { QueryClient } from '@tanstack/react-query';
import { GuiPluginHost } from './host';
import { NativeGuiSession } from './native';
import type { NativeGuiActivation, NativeGuiBridge } from './native-types';
import type { FilesAPI } from '@/lib/api/types';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import { NativeGuiError, requestNativeGui } from './native-errors';

const bridge = (window as unknown as { __YURI_DESKTOP__: { guiPlugins: NativeGuiBridge } }).__YURI_DESKTOP__.guiPlugins;
const activation = await requestNativeGui(bridge, 'acquire', { id: 'pdf-fixture', revision: '1' }) as NativeGuiActivation;
const native = new NativeGuiSession(bridge, activation);
const host = new GuiPluginHost({
  client: {} as OpenCodeClient, files: {} as FilesAPI, queryClient: new QueryClient(),
  transport: 'fixture', storage: window.localStorage, locale: 'en', mode: 'dark', narrow: false,
});
host.install('pdf-fixture', activation.bundle, native);
await host.runCommand('pdf-fixture.export');
const status = host.getSnapshot().plugins[0];
if (status.error) throw new Error(status.error);
host.dispose();
// Policy failures must keep their code through the actual preload/contextBridge.
try {
  await requestNativeGui(bridge, 'call', { lease: 'foreign', ipc: 'pdf-fixture.export', method: 'pdf', request: 'denied' });
  throw new Error('Foreign lease unexpectedly accepted');
} catch (error) {
  if (!(error instanceof NativeGuiError) || error.code !== 'GUI_PLUGIN_LEASE_EXPIRED') throw error;
}
await requestNativeGui(bridge, 'window-only', {});
try {
  await requestNativeGui(bridge, 'acquire', { id: 'pdf-fixture', revision: '1' });
  throw new Error('Restricted document unexpectedly activated native code');
} catch (error) {
  if (!(error instanceof NativeGuiError) || error.code !== 'GUI_PLUGIN_DOCUMENT_RESTRICTED') throw error;
}
const remote = new GuiPluginHost({
  client: {} as OpenCodeClient, files: {} as FilesAPI, queryClient: new QueryClient(),
  transport: 'remote-fixture', storage: window.localStorage, locale: 'en', mode: 'dark', narrow: false,
});
remote.setSession({ id: 'remote-session', directory: '/workspace' });
remote.install('remote', { revision: '1', options: {}, code: `
  const {Plugin,Panel,Command,Ipc}=require('@opencode/plugin/gui');
  module.exports=Plugin.define({
    main(){throw new Error('Remote main must not execute')},
    setup(ctx){
      ctx.add(Panel,{id:'preview',region:'side',list:()=>[{id:'report',title:'Remote report'}],render:()=>{
        const view=document.createElement('div');view.textContent='Remote report preview';return view;
      }});
      ctx.add(Command,{id:'fallback',title:'fallback',run:async()=>{
        try{await ctx.main(Ipc.define({id:'remote.export',methods:{pdf:{}}})).pdf()}
        catch(error){document.documentElement.dataset.refusal=error.code}
      }});
    }
  });
` });
const container = document.createElement('div'); document.body.append(container);
remote.selectPanel('remote:report');
const unmount = remote.mountPanel('remote:report', container);
await remote.runCommand('remote.fallback');
if (container.textContent !== 'Remote report preview' || document.documentElement.dataset.refusal !== 'GUI_PLUGIN_UNSUPPORTED') {
  throw new Error('Window-only rendering or native error consumption failed');
}
unmount(); remote.dispose();
document.documentElement.dataset.finished = 'true';
