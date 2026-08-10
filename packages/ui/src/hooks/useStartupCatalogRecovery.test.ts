import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('useStartupCatalogRecovery contract', () => {
  test('uses @reactuses/core interval/event helpers and a single recovery entry', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'useStartupCatalogRecovery.ts'), 'utf8');
    expect(source).toContain("from '@reactuses/core'");
    expect(source).toContain('useInterval');
    expect(source).toContain('useEvent');
    expect(source).toContain('refreshMissingCatalogs');
    expect(source).toContain('MAX_ATTEMPTS = 15');
    expect(source).toContain('INTERVAL_MS = 2000');
    // Immediate kick and interval share the same recovery entry.
    expect(source).toContain('void runRecovery()');
    expect(source).toContain('useInterval(runRecovery');
  });
});
