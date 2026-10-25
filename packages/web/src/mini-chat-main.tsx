import { createConfiguredWebAPIs } from './runtimeConfig';
import type { RuntimeAPIs } from '@yuriai/ui/lib/api/types';
import '@yuriai/ui/index.css';
import '@yuriai/ui/styles/fonts';

declare global {
  interface Window {
    __YURI_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__YURI_RUNTIME_APIS__ = createConfiguredWebAPIs();

void import('@yuriai/ui/apps/renderElectronMiniChatApp')
  .then(({ renderElectronMiniChatApp }) => {
    renderElectronMiniChatApp(window.__YURI_RUNTIME_APIS__ ?? createConfiguredWebAPIs());
  });
