import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { createHostHandshake, exportPublicKeyJwk, generateEcdhKeyPair } from '../../web/server/lib/relay/e2ee.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '../android/app/src/main/java/com/yuri/app');
let classes;
beforeAll(() => {
  classes = mkdtempSync(path.join(tmpdir(), 'yuri-native-notifications-'));
  execFileSync('javac', ['-d', classes, ...['NotificationRelayCrypto', 'NotificationSseParser', 'NotificationReconnect', 'NotificationFailure'].map((name) => path.join(source, `${name}.java`)), path.join(here, 'fixtures/NotificationHarness.java')]);
});
afterAll(() => { if (classes) rmSync(classes, { recursive: true, force: true }); });

it('executes the actual Java UTF-8/fragment parser and bounded reconnect policy', () => {
  expect(execFileSync('java', ['-cp', classes, 'com.yuri.app.NotificationHarness'], { encoding: 'utf8' }).trim()).toBe('PASS parser/backoff');
});

it('interoperates with the production relay host and rejects replay, tampering and oversized frames', async () => {
  const keys = await generateEcdhKeyPair();
  const jwk = await exportPublicKeyJwk(keys.publicKey);
  const child = spawn('java', ['-cp', classes, 'com.yuri.app.NotificationHarness', jwk.x, jwk.y], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const read = async () => {
    const result = await lines.next();
    if (result.done) throw new Error('Java harness exited');
    return result.value;
  };
  const command = async (kind, bytes) => { child.stdin.write(`${kind} ${Buffer.from(bytes).toString('base64url')}\n`); return read(); };
  try {
    const [x, y, nonce] = (await read()).split(' ');
    const host = createHostHandshake(keys.privateKey);
    const result = await host.handleText(JSON.stringify({ t: 'hello', v: 1, batch: false, nonce, clientPubJwk: { kty: 'EC', crv: 'P-256', x, y } }));
    expect(result.type).toBe('established');
    expect(result.batch).toBe(false);
    const request = Buffer.from('notification-only request 中文');
    const encrypted = Buffer.from(await command('E', request), 'base64url');
    expect(Buffer.from(await result.channel.decryptor.decrypt(encrypted))).toEqual(request);
    const event = Buffer.from('id: event-1\ndata: {"title":"完成"}\n\n');
    const down = await result.channel.encryptor.encrypt(event);
    expect(Buffer.from(await command('D', down), 'base64url')).toEqual(event);
    expect(await command('D', down)).toBe('REJECTED');
    const next = await result.channel.encryptor.encrypt(event);
    const tampered = Uint8Array.from(next);
    tampered[tampered.length - 1] ^= 1;
    expect(await command('D', tampered)).toBe('REJECTED');
    expect(Buffer.from(await command('D', next), 'base64url')).toEqual(event);
    expect(await command('E', new Uint8Array(65537))).toBe('REJECTED');
  } finally { child.stdin.end(); child.kill(); }
}, 10_000);
