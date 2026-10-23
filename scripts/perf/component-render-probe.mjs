import { writeFileSync } from 'node:fs';
import { openChromeSession, openPageSession } from '../../packages/ui/src/components/ui/chromeCdpHarness.ts';
import { installComponentRenderCounter, instrumentComponentRenderEntries } from './component-render-counter.mjs';
import { installTranscriptRenderObserver } from './transcript-render-observer.mjs';

const args = new Map(process.argv.slice(2).map((arg) => {
  const at = arg.indexOf('=');
  return [arg.slice(0, at), arg.slice(at + 1)];
}));
const url = args.get('--url');
if (!url) throw new Error('Pass --url=<session URL> and optionally --pre=25000 --out=<file>. Run with Bun.');
const pre = Number(args.get('--pre') ?? 0);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await openChromeSession({ width: 1440, height: 900 });
const intercepted = [];
const failures = [];
const pending = new Set();
const requests = new Map();
const scopes = new Map();
const scopeKey = (value) => {
  if (!value) return null;
  if (!scopes.has(value)) scopes.set(value, scopes.size + 1);
  return scopes.get(value);
};
try {
  const page = await openPageSession(browser, { width: 1440, height: 900, standalone: false });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installComponentRenderCounter.toString()})(globalThis);` });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installTranscriptRenderObserver.toString()})(globalThis);` });
  const intercept = async (params) => {
    if (params.responseStatusCode !== 200) {
      await page.send('Fetch.continueRequest', { requestId: params.requestId });
      return;
    }
    const body = await page.send('Fetch.getResponseBody', { requestId: params.requestId });
    const original = body.base64Encoded ? Buffer.from(body.body, 'base64').toString() : body.body;
    const result = instrumentComponentRenderEntries(original);
    if (!result.functions && !result.classes) {
      await page.send('Fetch.continueRequest', { requestId: params.requestId });
      return;
    }
    intercepted.push({ script: new URL(params.request.url).pathname, functions: result.functions, classes: result.classes });
    await page.send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: params.responseStatusCode,
      responseHeaders: (params.responseHeaders ?? []).filter((header) => !['content-length', 'content-encoding'].includes(header.name.toLowerCase())),
      body: Buffer.from(result.source).toString('base64'),
    });
  };
  browser.ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.sessionId !== page.sessionId) return;
    const params = message.params;
    if (message.method === 'Network.requestWillBeSent') {
      const requestUrl = new URL(params.request.url);
      const limit = requestUrl.searchParams.get('limit');
      if (limit === '50' || /worktrees|session-index/.test(requestUrl.pathname)) {
        let directories = [];
        try { directories = JSON.parse(params.request.postData ?? '{}').directories ?? []; } catch { /* Not a JSON request. */ }
        requests.set(params.requestId, { path: requestUrl.pathname, method: params.request.method,
          scope: scopeKey(requestUrl.searchParams.get('directory')),
          scopes: Array.isArray(directories) ? directories.map(scopeKey).sort((a, b) => a - b) : [],
          limit, before: requestUrl.searchParams.has('before') || requestUrl.searchParams.has('cursor'), epoch: params.wallTime * 1000, timestamp: params.timestamp });
      }
    }
    if (message.method === 'Network.responseReceived' && requests.has(params.requestId)) requests.get(params.requestId).status = params.response.status;
    if (message.method === 'Network.loadingFinished' && requests.has(params.requestId)) requests.get(params.requestId).duration = Math.round((params.timestamp - requests.get(params.requestId).timestamp) * 1000);
    if (message.method === 'Network.loadingFailed' && requests.has(params.requestId)) requests.get(params.requestId).failed = params.errorText;
    if (message.method !== 'Fetch.requestPaused') return;
    const operation = intercept(message.params).catch((error) => {
      failures.push(String(error));
      return page.send('Fetch.continueRequest', { requestId: message.params.requestId }).catch(() => {});
    });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*vendor-react*', resourceType: 'Script', requestStage: 'Response' }] });
  await page.send('Network.enable');
  await page.send('Page.navigate', { url });
  let ready = false;
  for (let i = 0; i < 300; i++) {
    ready = await page.evaluate(`(() => {
      const scroll = document.querySelector('.chat-scroll');
      if (!scroll?.querySelector('[data-message-id]')) return false;
      const rect = scroll.getBoundingClientRect();
      return scroll.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    })()`);
    if (ready) break;
    await wait(50);
  }
  if (!ready) throw new Error('Transcript did not become visible');
  if (intercepted.reduce((sum, item) => sum + item.functions, 0) !== 1 || intercepted.reduce((sum, item) => sum + item.classes, 0) !== 1) {
    throw new Error(`Unsupported React bundle: ${JSON.stringify(intercepted)}`);
  }
  await wait(pre);
  const pathname = await page.evaluate('location.pathname');
  if (pathname !== new URL(url).pathname) throw new Error(`Session changed before measurement: ${pathname}`);
  const point = await page.evaluate(`(() => {
    const rect = document.querySelector('.chat-scroll').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  const observation = await page.evaluate('(() => { const start = globalThis.__transcriptRenderObserver.start(); globalThis.__componentRenderCounter.start(); return start; })()');
  await wait(600);
  for (const deltaY of [...Array(40).fill(-120), ...Array(25).fill(120)]) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY });
    await wait(60);
  }
  await wait(800);
  const result = await page.evaluate('globalThis.__componentRenderCounter.stop()');
  const transcript = await page.evaluate('globalThis.__transcriptRenderObserver.stop()');
  const windowMs = await page.evaluate(`Date.now() - ${observation.epoch}`);
  let settled;
  const settleMs = Number(args.get('--settle') ?? 0);
  if (settleMs > 0) {
    const initial = await page.evaluate('(() => { const start = globalThis.__transcriptRenderObserver.start(); globalThis.__componentRenderCounter.start(); return start.initial; })()');
    await wait(settleMs);
    settled = await page.evaluate('({ ...globalThis.__componentRenderCounter.stop(), transcript: globalThis.__transcriptRenderObserver.stop() })');
    settled.transcript.initial = initial;
    settled.ms = settleMs;
    if (settled.missingFiber) throw new Error('Missing fiber during settling');
  }
  if (await page.evaluate('location.pathname') !== pathname) throw new Error('Session changed during measurement');
  if (failures.length || result.missingFiber || !result.components.length) throw new Error(JSON.stringify({ failures, result }));
  const network = [...requests.values()].map(({ epoch, timestamp: _timestamp, ...request }) => ({ at: Math.round(epoch - observation.epoch), ...request }));
  const output = { pre, pathname, intercepted, ...result, transcript: { initial: observation.initial, ...transcript }, windowMs,
    network: network.filter((request) => request.at <= windowMs),
    ...(settled ? { settled: { ...settled, network: network.filter((request) => request.at > windowMs) } } : {}) };
  if (args.has('--out')) writeFileSync(args.get('--out'), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ pre, areas: result.areas, hydration: result.hydration, transcript: { ...transcript, timeline: undefined }, history: network.filter((item) => item.limit === '50'), requests: network.length, top: result.components.slice(0, 10), missingFiber: result.missingFiber }));
} finally {
  await Promise.allSettled([...pending]);
  await browser.close();
}
