import { createConfiguredWebAPIs } from './runtimeConfig';
import type { RuntimeAPIs } from '@yuri/ui/lib/api/types';
import '@yuri/ui/index.css';
import '@yuri/ui/styles/fonts';

declare global {
  interface Window {
    __YURI_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__YURI_RUNTIME_APIS__ = createConfiguredWebAPIs();

void import('@yuri/ui/apps/renderMobileApp')
  .then(({ renderMobileApp }) => {
    renderMobileApp(window.__YURI_RUNTIME_APIS__ ?? createConfiguredWebAPIs());
  });
