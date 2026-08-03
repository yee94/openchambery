import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const sourceUrl = new URL('./MobileApp.tsx', import.meta.url);

test('keeps the active runtime after a transient mobile re-probe failure', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  const unreachableBranchStart = source.indexOf("if (outcome === 'unreachable') {");
  const retryTimerEnd = source.indexOf('        }, 4000);', unreachableBranchStart);
  const unreachableBranch = source.slice(unreachableBranchStart, retryTimerEnd);

  expect(unreachableBranchStart).toBeGreaterThan(-1);
  expect(retryTimerEnd).toBeGreaterThan(unreachableBranchStart);
  expect(unreachableBranch).toContain('return;');
  expect(unreachableBranch.indexOf('disconnect()')).toBe(-1);
});
