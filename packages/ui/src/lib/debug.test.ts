import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'debug.ts'), 'utf8');

describe('debug app status v2 mapping', () => {
  test('uses location.get and project.current without HeyAPI {data,error} or path.get', () => {
    expect(source).toContain('location.get');
    expect(source).toContain('project.current');
    expect(source).not.toContain('.path.get');
    expect(source).not.toContain('pathResult.error');
    expect(source).not.toContain('projectResult.error');
  });
});
