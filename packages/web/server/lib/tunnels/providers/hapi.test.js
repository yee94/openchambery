import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createHapiTunnelProvider, resolveTunwgBinary } from './hapi.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

describe('HAPI tunnel provider', () => {
  test('prefers an explicitly configured tunwg binary', async () => {
    if (process.platform === 'win32') return;
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-hapi-tunnel-'));
    temporaryDirectories.push(directory);
    const binaryPath = path.join(directory, 'tunwg');
    await fs.promises.writeFile(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

    expect(resolveTunwgBinary({ env: { OPENCHAMBER_TUNWG_PATH: binaryPath }, platform: process.platform })).toBe(binaryPath);
  });

  test('starts tunwg with the configured relay host and local OpenChamber origin', async () => {
    if (process.platform === 'win32') return;
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-hapi-tunnel-'));
    temporaryDirectories.push(directory);
    const binaryPath = path.join(directory, 'tunwg');
    const capturePath = path.join(directory, 'capture.json');
    await fs.promises.writeFile(binaryPath, `#!/bin/sh
printf '{"api":"%s","auth":"%s","keyPath":"%s","args":"%s"}' "$TUNWG_API" "$TUNWG_AUTH" "$TUNWG_PATH" "$*" > "$CAPTURE_PATH"
printf '{"event":"ready","url":"https://assigned.hapi.example"}\\n'
sleep 30
`, { mode: 0o700 });

    const provider = createHapiTunnelProvider({
      dataDir: directory,
      env: {
        ...process.env,
        OPENCHAMBER_TUNWG_PATH: binaryPath,
        OPENCHAMBER_HAPI_RELAY_AUTH: 'shared-secret',
        CAPTURE_PATH: capturePath,
      },
    });
    const controller = await provider.start(
      { mode: 'quick', hostname: 'relay.example.com' },
      { originUrl: 'http://127.0.0.1:5180' },
    );

    expect(controller.getPublicUrl()).toBe('https://assigned.hapi.example');
    expect(JSON.parse(await fs.promises.readFile(capturePath, 'utf8'))).toEqual({
      api: 'relay.example.com',
      auth: 'shared-secret',
      keyPath: path.join(directory, 'hapi-tunnel', 'tunwg'),
      args: '--json --forward=http://127.0.0.1:5180',
    });
    expect(await provider.readPersistedHostname()).toBe('relay.example.com');
    controller.stop();
  });
});
