import { expect, test } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test.skipIf(process.platform !== 'darwin')('native loopback server handles ranges, HEAD, disconnect cancellation and opaque paths', async () => {
  const work = await mkdtemp(join(tmpdir(), 'yuri-video-native-'));
  let child;
  try {
    const binary = join(work, 'video-probe');
    execFileSync('swiftc', [fileURLToPath(new URL('../ios/App/App/YuriVideoServer.swift', import.meta.url)),
      fileURLToPath(new URL('./fixtures/VideoServerProbe.swift', import.meta.url)), '-o', binary]);
    child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [];
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    createInterface({ input: child.stdout }).on('line', line => {
      const event = JSON.parse(line);
      if (event.url) ready(event.url);
      else events.push(event);
    });
    const url = await started;
    const responsePromise = fetch(url, { headers: { Range: 'bytes=20-23' } });
    await expect.poll(() => events.length).toBe(1);
    expect(events[0]).toMatchObject({ range: 'bytes=20-23', method: 'GET' });
    child.stdin.write(JSON.stringify({ requestId: events[0].requestId, status: 206, contentType: 'video/mp4',
      contentRange: 'bytes 20-23/5000000000', contentLength: 4, dataBase64: Buffer.from('test').toString('base64') }) + '\n');
    const response = await responsePromise;
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 20-23/5000000000');
    expect(await response.text()).toBe('test');
    expect((await fetch(url + '/other')).status).toBe(404);
    expect((await fetch(url, { headers: { Range: 'bytes=0-2,5-7' } })).status).toBe(400);
    const headPromise = fetch(url, { method: 'HEAD' });
    await expect.poll(() => events.filter(e => e.method === 'HEAD').length).toBe(1);
    const head = events.find(e => e.method === 'HEAD');
    child.stdin.write(JSON.stringify({ requestId: head.requestId, status: 200, contentLength: 5000000000, dataBase64: '' }) + '\n');
    const headResponse = await headPromise;
    expect(headResponse.headers.get('content-length')).toBe('5000000000');
    expect(await headResponse.text()).toBe('');
    const abort = new AbortController();
    const aborted = fetch(url, { signal: abort.signal, headers: { Range: 'bytes=500-' } }).catch(error => error.name);
    await expect.poll(() => events.filter(e => e.range === 'bytes=500-').length).toBe(1);
    abort.abort();
    expect(await aborted).toBe('AbortError');
    await expect.poll(() => events.some(e => e.cancelled)).toBe(true);
  } finally {
    child?.kill();
    await rm(work, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(process.platform !== 'darwin')('AVFoundation decodes first frame and seeks through the production loopback server', async () => {
  const work = await mkdtemp(join(tmpdir(), 'yuri-video-playback-'));
  try {
    const binary = join(work, 'playback-probe');
    execFileSync('swiftc', [fileURLToPath(new URL('../ios/App/App/YuriVideoServer.swift', import.meta.url)),
      fileURLToPath(new URL('./fixtures/VideoPlaybackProbe.swift', import.meta.url)), '-o', binary]);
    const output = execFileSync(binary, [], { timeout: 20_000, encoding: 'utf8' });
    expect(output).toContain('AVFoundation first frame and forward/backward seek passed');
  } finally { await rm(work, { recursive: true, force: true }); }
}, 30_000);
