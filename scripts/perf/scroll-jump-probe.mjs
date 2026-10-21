#!/usr/bin/env bun
// Real-browser reading-position probe for transcript scrollers.
//
// Scrolls a live page upward (wheel on desktop, touch drags with --mobile),
// samples the reading row every frame, and counts passive jumps: frames where
// the row moved in the document by more than input explains. See
// .agents/skills/scroll-anchoring/SKILL.md for how to read the result.
//
//   bun scripts/perf/scroll-jump-probe.mjs --url <page> --scroller <css> [--mobile]
//     [--steps 160] [--gap ms] [--tail ms] [--open-title <title>] [--max-jumps n] [--out file]
//
// Exit code 1 when --max-jumps is set and exceeded, so the probe can gate a change.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openChromeSession, openPageSession } from '../../packages/ui/src/components/ui/chromeCdpHarness.ts';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    scroller: { type: 'string', default: '.chat-scroll' },
    row: { type: 'string', default: '[data-message-id]' },
    mobile: { type: 'boolean', default: false },
    steps: { type: 'string' },
    gap: { type: 'string' },
    tail: { type: 'string', default: '2500' },
    'open-title': { type: 'string' },
    'max-jumps': { type: 'string' },
    out: { type: 'string' },
  },
});
if (!args.url) throw new Error('--url is required');

const mobile = args.mobile;
const width = mobile ? 390 : 978;
const height = mobile ? 844 : 758;
const steps = Number(args.steps ?? (mobile ? 40 : 160));
const gap = Number(args.gap ?? (mobile ? 400 : 60));
// One wheel notch / one touchmove step; whole multiples are input, not layout.
const unit = mobile ? 40 : 120;
const SC = JSON.stringify(args.scroller);
const ROW = JSON.stringify(args.row);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await openChromeSession({ width, height });
try {
  const page = await openPageSession(browser, { width, height, standalone: false });
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
  if (mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.send('Page.navigate', { url: args.url });

  const ready = () => page.evaluate(`!!document.querySelector(${SC})?.querySelector(${ROW})`);
  let ok = false;
  for (let i = 0; i < 200 && !ok; i += 1) { ok = await ready(); if (!ok) await sleep(150); }
  if (!ok && args['open-title']) {
    // Phone surfaces ignore deep paths on cold start; open through global search.
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'p', code: 'KeyP', modifiers: 4, windowsVirtualKeyCode: 80 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', modifiers: 4, windowsVirtualKeyCode: 80 });
    await sleep(1000);
    await page.evaluate(`document.querySelector('[data-global-search] input, [cmdk-input], [role=dialog] input')?.focus()`);
    await page.send('Input.insertText', { text: args['open-title'] });
    await sleep(2000);
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    for (let i = 0; i < 60 && !ok; i += 1) { await sleep(200); ok = await ready(); }
  }
  if (!ok) throw new Error(`no ${args.row} inside ${args.scroller} at ${await page.evaluate('location.href')}`);
  await page.evaluate(`document.getElementById('initial-loading')?.remove()`);
  await sleep(3000);

  await page.evaluate(`(() => {
    const sc = document.querySelector(${SC});
    window.__probe = { log: [], touching: false };
    sc.addEventListener('touchstart', () => { window.__probe.touching = true; }, { capture: true, passive: true });
    sc.addEventListener('touchend', () => { window.__probe.touching = false; }, { capture: true, passive: true });
    const pick = () => { const r = sc.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(${ROW}) ?? null; };
    // MessageChannel samples after layout of each frame, before the next input.
    const channel = new MessageChannel(); let prev = null;
    channel.port1.onmessage = () => {
      const r = sc.getBoundingClientRect();
      let row = prev?.row?.isConnected ? prev.row : null;
      if (row) { const b = row.getBoundingClientRect(); if (b.bottom < r.top || b.top > r.bottom) row = null; }
      const same = Boolean(row); if (!row) row = pick();
      const s = { t: performance.now(), touching: window.__probe.touching, st: sc.scrollTop, sh: sc.scrollHeight, n: sc.querySelectorAll(${ROW}).length, top: row ? row.getBoundingClientRect().top - r.top : null };
      if (same && prev && s.top !== null) { s.dTop = s.top - prev.top; s.dDoc = (s.top + s.st) - (prev.top + prev.st); }
      window.__probe.log.push(s); prev = { ...s, row };
    };
    const tick = () => { channel.port2.postMessage(0); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })()`);

  const box = await page.evaluate(`(() => { const r = document.querySelector(${SC}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (let i = 0; i < steps; i += 1) {
    if (mobile) {
      const y0 = box.y - 200;
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: y0 }] });
      for (let k = 1; k <= 8; k += 1) { await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x, y: y0 + k * unit }] }); await sleep(20); }
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -unit });
    }
    await sleep(gap);
  }
  await sleep(Number(args.tail));

  const log = await page.evaluate('window.__probe.log');
  if (args.out) writeFileSync(args.out, JSON.stringify(log));
  const jumps = [];
  for (let i = 1; i < log.length; i += 1) {
    const s = log[i], q = log[i - 1];
    if (s.dTop === undefined || Math.abs(s.dDoc) <= 1 || s.st <= 0) continue;
    const residual = s.dTop - unit * Math.round(s.dTop / unit);
    if (Math.abs(s.dTop) <= 2 || Math.abs(residual) <= 2) continue;
    jumps.push({ t: Math.round(s.t), dTop: +s.dTop.toFixed(1), dDoc: +s.dDoc.toFixed(1), touching: s.touching, rows: [q.n, s.n], prepend: s.n > q.n });
  }
  const end = log.at(-1);
  console.log(JSON.stringify({
    mobile,
    frames: log.length,
    loads: log.filter((s, i) => i && s.n > log[i - 1].n).length,
    end: { scrollTop: end.st, scrollHeight: end.sh, rows: end.n },
    jumps: jumps.length,
    prependJumps: jumps.filter((j) => j.prepend).length,
    jumpPx: +jumps.reduce((total, j) => total + Math.abs(j.dTop), 0).toFixed(1),
  }));
  for (const jump of jumps.slice(0, 20)) console.log(JSON.stringify(jump));
  if (args['max-jumps'] !== undefined && jumps.length > Number(args['max-jumps'])) process.exitCode = 1;
} finally {
  await browser.close();
}
