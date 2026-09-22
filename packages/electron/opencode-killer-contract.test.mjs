import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.mjs'),
  'utf8',
);

describe('Electron managed OpenCode quit cleanup contract', () => {
  it('does not keep a pre-stop numeric-pid detached killer fallback', () => {
    expect(mainSource).not.toMatch(/launchDetachedOpenCodeKiller/);
    expect(mainSource).not.toMatch(/OPENCODE_SHUTDOWN_GRACE_MS/);
    expect(mainSource).not.toMatch(/openchamber-opencode-killer/);

    const start = mainSource.indexOf('const shutdownInProcessServer');
    expect(start).toBeGreaterThan(0);
    const end = mainSource.indexOf('const macosMajorVersion', start);
    expect(end).toBeGreaterThan(start);
    const block = mainSource.slice(start, end);

    expect(block).toMatch(/handle\.stop\(\{\s*exitProcess:\s*false,\s*forceCloseConnections:\s*true/);
    expect(block).not.toMatch(/getOpenCodeProcessInfo/);
    expect(block).toMatch(/Do not snapshot a numeric managed pid/);
  });
});
