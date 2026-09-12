import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const expoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('package-lock file: deps', () => {
  it('records openchamber-system-shell as a linked file package so npm ci stays in sync', () => {
    const lock = JSON.parse(readFileSync(path.join(expoRoot, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { resolved?: string; link?: boolean; version?: string }>;
    };
    const source = lock.packages?.['modules/openchamber-system-shell'];
    const linked = lock.packages?.['node_modules/openchamber-system-shell'];
    expect(source?.version).toBe('1.19.7-beta.7');
    expect(linked).toEqual({
      resolved: 'modules/openchamber-system-shell',
      link: true,
    });
  });
});
