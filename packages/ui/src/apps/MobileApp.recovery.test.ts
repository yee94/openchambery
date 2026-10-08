import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'MobileApp.tsx');

test('mounts global search inside the dedicated mobile actions provider', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const providerStart = source.indexOf('<DedicatedMobileAppProvider actions={mobileActions}>');
  const providerEnd = source.indexOf('</DedicatedMobileAppProvider>', providerStart);
  expect(source.slice(providerStart, providerEnd)).toContain('<MobileGlobalSearchHost>');
  expect(source.slice(providerStart, providerEnd)).not.toContain('<CommandPalette />');
});

test('keeps the active runtime after a transient mobile re-probe failure', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const unreachableBranchStart = source.indexOf("if (outcome === 'unreachable') {");
  const retryTimerEnd = source.indexOf('        }, 4000);', unreachableBranchStart);
  const unreachableBranch = source.slice(unreachableBranchStart, retryTimerEnd);

  expect(unreachableBranchStart).toBeGreaterThan(-1);
  expect(retryTimerEnd).toBeGreaterThan(unreachableBranchStart);
  expect(unreachableBranch).toContain('return;');
  expect(unreachableBranch.indexOf('disconnect()')).toBe(-1);
});
