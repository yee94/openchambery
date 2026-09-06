import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { LYNX_CHAT_LIST_ENGINE, LYNX_FORBIDDEN_CHAT_LIST_ENGINE } from './list-contract';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)));

async function walkTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkTsFiles(path));
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(path);
  }
  return files;
}

const ALLOW_FORBIDDEN_NAME_MENTION = new Set([
  'list-contract.test.ts',
  'list-contract.ts',
  'listSemantics.ts',
  'listSemantics.test.ts',
]);

describe('Lynx chat list contract', () => {
  test('scaffold commits to LegendList 1.19 and does not import TanStack Virtual', async () => {
    expect(LYNX_CHAT_LIST_ENGINE).toBe('legendlist-1.19');
    expect(LYNX_FORBIDDEN_CHAT_LIST_ENGINE).toBe('tanstack-virtual-1.18');
    const files = await walkTsFiles(srcRoot);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source).not.toMatch(/from ['"]@tanstack\/react-virtual['"]/);
      const base = file.split('/').pop() ?? file;
      if (!ALLOW_FORBIDDEN_NAME_MENTION.has(base)) {
        expect(source).not.toContain('StaticHistoryList');
        expect(source).not.toContain('StreamingTailContent');
      }
    }
  });
});
