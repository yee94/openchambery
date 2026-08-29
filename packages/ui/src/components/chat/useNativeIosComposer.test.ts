import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'useNativeIosComposer.ts'), 'utf-8');

describe('useNativeIosComposer', () => {
  test('keeps send, attach, and model as ChatInput events and uses useEvent', () => {
    expect(source).toContain("from '@reactuses/core'");
    expect(source).toContain('useEvent');
    expect(source).not.toContain('useCallback');
    expect(source).toContain("addListener('send'");
    expect(source).toContain("addListener('attach'");
    expect(source).toContain("addListener('openModel'");
    expect(source).toContain('plugin.present');
    expect(source).toContain('plugin.dismiss');
    expect(source).toContain('getNativeIosComposerPlugin().update');
    expect(source).toContain('setNativeComposerDocumentClass');
    expect(source).toContain('applyNativeComposerHeightVar');
  });
});
