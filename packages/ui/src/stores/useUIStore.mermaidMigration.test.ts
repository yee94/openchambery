import { describe, expect, test } from 'vitest';
import { useUIStore } from './useUIStore';

describe('retired Mermaid preference', () => {
  test.each(['ascii', 'svg', null, {}, 'invalid'])('drops old mode %j without changing other preferences', async (mermaidRenderingMode) => {
    const options = useUIStore.persist.getOptions();
    expect(options.version).toBeGreaterThan(13);
    const migrated = await options.migrate!({ mermaidRenderingMode, codeBlockLineWrap: false }, 13);
    expect(migrated).not.toHaveProperty('mermaidRenderingMode');
    expect(migrated).toHaveProperty('codeBlockLineWrap', false);
    expect(options.partialize!(useUIStore.getState())).not.toHaveProperty('mermaidRenderingMode');
  });
});
