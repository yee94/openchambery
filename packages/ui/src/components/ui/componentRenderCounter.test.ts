import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('counts actual render calls, including StrictMode, while ignoring memo bailout subtrees', () => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../scripts/perf/verify-component-render-counter.mjs');
  const output = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  expect(JSON.parse(output)).toEqual([
    { nested: false, mode: 'bailout', actual: 0, measured: 0 },
    { nested: false, mode: 'update', actual: 50, measured: 50 },
    { nested: true, mode: 'bailout', actual: 0, measured: 0 },
    { nested: true, mode: 'update', actual: 100, measured: 100 },
    { mode: 'strict-forwardRef-class', actual: 6, measured: 6 },
  ]);
});
