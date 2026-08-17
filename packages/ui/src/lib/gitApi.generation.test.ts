import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gitApi.ts'), 'utf8');

describe('gitApi session generation v2 mapping', () => {
  test('prompts with text/delivery and reads assistant text from message.list', () => {
    expect(source).toContain("delivery: 'steer'");
    expect(source).toContain('session.prompt');
    expect(source).toContain('message.list');
    expect(source).not.toContain('parts: promptParts');
    expect(source).not.toContain('response?.error');
    expect(source).not.toContain('getApiClient().session.prompt');
  });
});
