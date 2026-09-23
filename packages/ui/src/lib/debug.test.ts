import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'debug.ts'), 'utf8');

describe('debug app status v2 mapping', () => {
  test('uses location.get for path/project without HeyAPI {data,error} or path.get', () => {
    expect(source).toContain('location.get');
    // Comments may mention the dropped project.current API; code must not call it.
    expect(source).not.toMatch(/project\.current\s*\(/);
    expect(source).not.toContain('.path.get');
    expect(source).not.toContain('pathResult.error');
    expect(source).not.toContain('projectResult.error');
  });
});
