import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));

describe('AssistantView synthetic part consumption', () => {
  test('filters mobile share handoff markers after consuming the draft parts', async () => {
    const source = await readFile(join(directory, 'AssistantView.tsx'), 'utf8');
    const consume = source.indexOf('input.consumeDraftSyntheticParts(draftKey)');
    const filter = source.indexOf('filter((part) => !isMobileShareHandoffMarkerPart(part))');
    expect(consume).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(consume);
  });
});
