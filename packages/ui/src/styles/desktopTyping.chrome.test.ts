import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { messageHoverHandlers } from '../components/chat/lib/messageHover';
import { compileProductionCssAsync, evidenceRoot, keepEvidence, openChromeSession, openPageSession, resolveChrome } from '../components/ui/chromeCdpHarness';

test.skipIf(!resolveChrome())('desktop typing does not invalidate the retained transcript tree', async () => {
  const root = evidenceRoot();
  const chrome = await openChromeSession({ width: 1842, height: 1892 });
  try {
    const source = join(dirname(fileURLToPath(import.meta.url)), '..');
    const css = await compileProductionCssAsync(source);
    const html = join(root, 'desktop-typing.html');
    writeFileSync(html, `<!doctype html><html class="desktop-runtime dark" data-oc-vibrancy data-oc-vibrancy-ready>
      <head><style>${css}</style></head><body style="--sidebar: rgb(10,20,30); --sidebar-vibrancy-overlay: rgba(10,20,30,.5)">
      <aside class="oc-vibrancy-surface">Sidebar</aside><main id="history"></main><textarea data-chat-input="true"></textarea>
      <script>
      const history=document.querySelector('#history');
      const fragment=document.createDocumentFragment();
      for(let i=0;i<21000;i++){const node=document.createElement('span');node.className='text-foreground';node.textContent='text';fragment.append(node)}
      history.append(fragment);
      const textarea=document.querySelector('textarea');textarea.focus();void textarea.scrollTop;
      window.ready=true;
      window.typeProbe=()=>{const times=[];for(let i=0;i<30;i++){const start=performance.now();textarea.value='typing '+i;textarea.defaultValue=textarea.value;void textarea.scrollTop;times.push(performance.now()-start)}times.sort((a,b)=>a-b);return {p50:times[15],p95:times[28]}};
      </script></body></html>`);
    const page = await openPageSession(chrome, { width: 1842, height: 1892, standalone: false });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1842, height: 1892, deviceScaleFactor: 1, mobile: false });
    await page.navigateFile(html);
    expect(await page.evaluate('window.ready')).toBe(true);
    const recalcSizes: number[] = [];
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    const listener = (message: MessageEvent) => {
      const event = JSON.parse(String(message.data));
      if (event.method === 'Tracing.tracingComplete') complete();
      if (event.method === 'Tracing.dataCollected') {
        for (const entry of event.params.value) {
          if (entry.name === 'UpdateLayoutTree') recalcSizes.push(entry.args?.elementCount ?? 0);
        }
      }
    };
    chrome.ws.addEventListener('message', listener);
    try {
      await chrome.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
      const timing = await page.evaluate<{ p50: number; p95: number }>('window.typeProbe()');
      await chrome.send('Tracing.end');
      await completed;
      expect(recalcSizes.length).toBeGreaterThan(0);
      // Operation-count guard, independent of CPU speed: editing one textarea
      // must never restyle the 21k-node conversation/sidebar cache.
      expect(Math.max(...recalcSizes)).toBeLessThan(100);
      expect(timing.p95).toBeLessThan(16);
      const colors = await page.evaluate<string[]>(`(() => {
        const surface=document.querySelector('.oc-vibrancy-surface');
        const normal=getComputedStyle(surface).backgroundColor;
        document.documentElement.setAttribute('data-oc-native-browser-visible','');
        const browser=getComputedStyle(surface).backgroundColor;
        document.documentElement.removeAttribute('data-oc-native-browser-visible');
        return [normal,browser,getComputedStyle(surface).backgroundColor];
      })()`);
      expect(colors).toEqual(['rgba(10, 20, 30, 0.5)', 'rgb(10, 20, 30)', 'rgba(10, 20, 30, 0.5)']);
    } finally {
      chrome.ws.removeEventListener('message', listener);
    }
  } finally {
    await chrome.close();
    if (!keepEvidence()) rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(!resolveChrome())('message hover during scrolling restyles only chrome, not rich message descendants', async () => {
  const root = evidenceRoot();
  const chrome = await openChromeSession({ width: 900, height: 700 });
  try {
    const source = join(dirname(fileURLToPath(import.meta.url)), '..');
    const body = readFileSync(join(source, 'components/chat/message/MessageBody.tsx'), 'utf8');
    // Read production call-site classes so restoring a broad group-hover utility
    // also changes this browser regression fixture.
    const scope = body.match(/className="relative w-full ([^"]+)"/)![1];
    const time = body.match(/: '(hidden [^']+)',\s*\)\}\s*data-message-time/)![1];
    const actions = body.match(/: '(pointer-events-none opacity-0 transition-opacity[^']+)'/)![1];
    const css = await compileProductionCssAsync(source);
    const html = join(root, 'message-hover.html');
    writeFileSync(html, `<!doctype html><html><head><style>${css}</style></head><body>
      <div id="scroller" style="height:600px;overflow:auto;width:700px">
      ${Array.from({ length: 3 }, (_, i) => `<div class="relative w-full ${scope}" style="height:600px">
        <span class="${time}" data-message-time>timestamp ${i}</span>
        <div class="${actions}" data-action-probe>Copy / Fork</div>
        <div>${'<span class="text-foreground">rich text </span>'.repeat(5000)}</div>
      </div>`).join('')}</div><script>
      document.querySelectorAll('.${scope}').forEach(scope => {
        scope.addEventListener('pointerenter', ${messageHoverHandlers.onPointerEnter.toString()});
        scope.addEventListener('pointerleave', ${messageHoverHandlers.onPointerLeave.toString()});
      });
      </script></body></html>`);
    const page = await openPageSession(chrome, { width: 900, height: 700, standalone: false });
    await page.navigateFile(html);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 800, y: 300 });
    const sizes: number[] = [];
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    const listener = (message: MessageEvent) => {
      const event = JSON.parse(String(message.data));
      if (event.method === 'Tracing.tracingComplete') complete();
      if (event.method === 'Tracing.dataCollected') for (const entry of event.params.value) {
        if (entry.name === 'UpdateLayoutTree') sizes.push(entry.args?.elementCount ?? 0);
      }
    };
    chrome.ws.addEventListener('message', listener);
    try {
      await chrome.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 200 });
      const visible = await page.evaluate<string>(`getComputedStyle(document.querySelector('[data-message-time]')).display`);
      expect(await page.evaluate(`getComputedStyle(document.querySelector('[data-action-probe]')).pointerEvents`)).toBe('auto');
      for (const top of [600, 1200, 600, 0]) {
        await page.evaluate(`document.querySelector('#scroller').scrollTop=${top}`);
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 301, y: 201 });
        await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      }
      await chrome.send('Tracing.end');
      await completed;
      expect(visible).toBe('inline-flex');
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.max(...sizes)).toBeLessThan(100);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 800, y: 300 });
      expect(await page.evaluate(`getComputedStyle(document.querySelector('[data-message-time]')).display`)).toBe('none');
      expect(await page.evaluate(`getComputedStyle(document.querySelector('[data-action-probe]')).pointerEvents`)).toBe('none');
    } finally { chrome.ws.removeEventListener('message', listener); }
  } finally {
    await chrome.close();
    if (!keepEvidence()) rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
