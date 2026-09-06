/**
 * Shared headless Chrome CDP harness for production-linked UI tests.
 * Unique temp user-data-dir; no developer profile. Profiles always cleaned.
 * Evidence retention keeps fixture/screenshots only.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'chromium',
  'chromium-browser',
] as const;

const CDP_COMMAND_TIMEOUT_MS = 20_000;

export const resolveChrome = (): string | null => {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate.includes('/') && existsSync(candidate)) return candidate;
    if (!candidate.includes('/')) {
      const which = spawnSync('which', [candidate], { encoding: 'utf8' });
      if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
    }
  }
  return null;
};

export const evidenceRoot = (): string => {
  const fromEnv = process.env.OPENCHAMBER_TEST_EVIDENCE_DIR?.trim();
  if (fromEnv) {
    mkdirSync(fromEnv, { recursive: true });
    return fromEnv;
  }
  return mkdtempSync(join(tmpdir(), 'oc-openchamber-evidence-'));
};

export const keepEvidence = (): boolean => (
  process.env.OPENCHAMBER_TEST_KEEP_EVIDENCE === '1'
  || process.env.OPENCHAMBER_TEST_KEEP_EVIDENCE === 'true'
  || Boolean(process.env.OPENCHAMBER_TEST_EVIDENCE_DIR?.trim())
);

export const compileProductionCssAsync = async (uiSrcDir: string): Promise<string> => {
  // Runner lives in OS tmp; bun resolves deps from cwd=packages/ui.
  const uiPkg = join(uiSrcDir, '..');
  const runnerDir = mkdtempSync(join(tmpdir(), 'oc-css-compile-'));
  const runnerPath = join(runnerDir, 'compile.mjs');
  const outPath = join(runnerDir, 'out.css');
  const entry = join(uiSrcDir, 'index.css');
  writeFileSync(
    runnerPath,
    `import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { readFileSync, writeFileSync } from 'node:fs';
const entry = ${JSON.stringify(entry)};
const out = ${JSON.stringify(outPath)};
const css = readFileSync(entry, 'utf8');
const result = await postcss([tailwindcss]).process(css, { from: entry });
writeFileSync(out, result.css);
`,
    'utf8',
  );
  try {
    const run = spawnSync('bun', [runnerPath], {
      cwd: uiPkg,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      throw new Error(`production CSS compile failed: ${run.stderr || run.stdout}`);
    }
    return readFileSync(outPath, 'utf8');
  } finally {
    try { rmSync(runnerDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
};

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
};

type PendingWaiter = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ChromeSession = {
  chrome: ChildProcess;
  ws: WebSocket;
  userDataDir: string;
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
};

const waitForWs = (url: string, timeoutMs = 15_000): Promise<WebSocket> => (
  new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`CDP WebSocket timeout: ${url}`));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`CDP WebSocket error: ${url}`));
    });
  })
);

const readDevtoolsUrl = async (portFile: string, timeoutMs = 15_000): Promise<string> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, 'utf8').trim();
      const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
      const port = lines[0];
      const path = lines[1] ?? '/devtools/browser';
      if (port) return `ws://127.0.0.1:${port}${path.startsWith('/') ? path : `/${path}`}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Chrome DevToolsActivePort not ready');
};

const rejectAllPending = (pending: Map<number, PendingWaiter>, reason: Error) => {
  for (const [id, waiter] of pending) {
    clearTimeout(waiter.timer);
    pending.delete(id);
    waiter.reject(reason);
  }
};

export const openChromeSession = async (opts?: {
  width?: number;
  height?: number;
}): Promise<ChromeSession> => {
  const chromePath = resolveChrome();
  if (!chromePath) throw new Error('CHROME_UNAVAILABLE');

  const width = opts?.width ?? 390;
  const height = opts?.height ?? 844;
  const userDataDir = mkdtempSync(join(tmpdir(), 'oc-chrome-profile-'));
  const portFile = join(userDataDir, 'DevToolsActivePort');

  let chrome: ChildProcess;
  try {
    chrome = spawn(chromePath, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--user-data-dir=${userDataDir}`,
      `--window-size=${width},${height}`,
      '--force-device-scale-factor=1',
      'about:blank',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw error instanceof Error ? error : new Error(String(error));
  }

  let stderr = '';
  chrome.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  chrome.on('error', (error) => {
    stderr += error.message;
  });

  let browserWs: WebSocket;
  try {
    const wsUrl = await readDevtoolsUrl(portFile);
    browserWs = await waitForWs(wsUrl);
  } catch (error) {
    try { chrome.kill('SIGKILL'); } catch { /* ignore */ }
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(`Chrome CDP connect failed: ${error instanceof Error ? error.message : String(error)} stderr=${stderr.slice(0, 400)}`);
  }

  let nextId = 1;
  let closed = false;
  const pending = new Map<number, PendingWaiter>();

  browserWs.addEventListener('message', (event) => {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(String(event.data)) as CdpMessage;
    } catch {
      return;
    }
    if (msg.id == null) return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message ?? 'CDP error'));
    else waiter.resolve(msg.result ?? {});
  });

  browserWs.addEventListener('close', () => {
    closed = true;
    rejectAllPending(pending, new Error('CDP WebSocket closed'));
  });
  browserWs.addEventListener('error', () => {
    closed = true;
    rejectAllPending(pending, new Error('CDP WebSocket error'));
  });

  const send = (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => (
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (closed || browserWs.readyState !== WebSocket.OPEN) {
        reject(new Error(`CDP send after close: ${method}`));
        return;
      }
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout (${CDP_COMMAND_TIMEOUT_MS}ms): ${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        const payload: Record<string, unknown> = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        browserWs.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    })
  );

  const close = async () => {
    closed = true;
    rejectAllPending(pending, new Error('CDP session closed'));
    try { browserWs.close(); } catch { /* ignore */ }
    try { chrome.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
    try { chrome.kill('SIGKILL'); } catch { /* ignore */ }
    // Profiles always cleaned — evidence retention keeps fixtures/screenshots only.
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return { chrome, ws: browserWs, userDataDir, send, close };
};

type PageSession = {
  sessionId: string;
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  navigateFile: (filePath: string) => Promise<void>;
  evaluate: <T>(expression: string) => Promise<T>;
  screenshotPng: (outPath: string) => Promise<string>;
  /** Sample center-column RGB from a captured screenshot via in-page Image+canvas. */
  sampleScreenshotCenterColumn: (pngPath: string, rowsFromBottom: number[]) => Promise<RgbSample[]>;
  width: number;
  height: number;
};

export type RgbSample = { y: number; r: number; g: number; b: number };

export const openPageSession = async (
  session: ChromeSession,
  opts: { width?: number; height?: number; standalone?: boolean } = {},
): Promise<PageSession> => {
  const width = opts.width ?? 390;
  const height = opts.height ?? 844;
  const target = await session.send('Target.createTarget', { url: 'about:blank' });
  const targetId = String(target.targetId ?? '');
  const attached = await session.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = String(attached.sessionId ?? '');

  const send = (method: string, params?: Record<string, unknown>) => (
    session.send(method, params, sessionId)
  );

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: true,
  });
  if (opts.standalone !== false) {
    await send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'display-mode', value: 'standalone' }],
    });
  }

  const navigateFile = async (filePath: string) => {
    await send('Page.navigate', { url: `file://${filePath}` });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = await send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      });
      const value = (ready.result as { value?: string } | undefined)?.value;
      if (value === 'complete' || value === 'interactive') break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  };

  const evaluate = async <T,>(expression: string): Promise<T> => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const remote = result.result as { value?: T; type?: string } | undefined;
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return remote?.value as T;
  };

  const screenshotPng = async (outPath: string) => {
    const result = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const data = String(result.data ?? '');
    writeFileSync(outPath, Buffer.from(data, 'base64'));
    return outPath;
  };

  const sampleScreenshotCenterColumn = async (
    pngPath: string,
    rowsFromBottom: number[],
  ): Promise<RgbSample[]> => {
    const dataUrl = `data:image/png;base64,${readFileSync(pngPath).toString('base64')}`;
    // Sample in the browser via Image + canvas — no python/Pillow dependency.
    const expression = `(() => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) { reject(new Error('no 2d context')); return; }
          ctx.drawImage(img, 0, 0);
          const w = canvas.width;
          const h = canvas.height;
          const x = Math.floor(w / 2);
          const rows = ${JSON.stringify(rowsFromBottom)};
          const samples = rows.map((fb) => {
            const y = Math.max(0, Math.min(h - 1, h - 1 - Number(fb)));
            const d = ctx.getImageData(x, y, 1, 1).data;
            return { y, r: d[0], g: d[1], b: d[2] };
          });
          resolve(samples);
        } catch (error) {
          reject(error);
        }
      };
      img.onerror = () => reject(new Error('image load failed'));
      img.src = ${JSON.stringify(dataUrl)};
    }))()`;
    return evaluate<RgbSample[]>(expression);
  };

  return {
    sessionId,
    send,
    navigateFile,
    evaluate,
    screenshotPng,
    sampleScreenshotCenterColumn,
    width,
    height,
  };
};

export const isNearColor = (
  sample: RgbSample,
  target: { r: number; g: number; b: number },
  tolerance = 18,
): boolean => (
  Math.abs(sample.r - target.r) <= tolerance
  && Math.abs(sample.g - target.g) <= tolerance
  && Math.abs(sample.b - target.b) <= tolerance
);

export const bundleUiModule = async (
  entryAbs: string,
  outfileAbs: string,
  aliasAt: string,
): Promise<void> => {
  const pkgRoot = aliasAt.endsWith('/src') || aliasAt.endsWith('\\src')
    ? dirname(aliasAt)
    : join(aliasAt, '..');
  const run = spawnSync('bun', [
    'build',
    entryAbs,
    `--outfile=${outfileAbs}`,
    '--format=iife',
    '--global-name=OcIframeOverscroll',
    '--target=browser',
  ], {
    cwd: pkgRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`bun build failed: ${run.stderr || run.stdout}`);
  }
};
