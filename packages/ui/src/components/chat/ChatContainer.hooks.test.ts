import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('ChatContainer source contracts', () => {
    const source = readFileSync(join(here, 'ChatContainer.tsx'), 'utf8');

    test('handlers use useEvent; no React.useCallback', () => {
        expect(source).toContain("from '@reactuses/core'");
        expect(source).toContain('useEvent');
        expect(source).not.toContain('React.useCallback');
        // Comments may mention useCallback as a ban; ban the call form only.
        expect(source).not.toMatch(/(?<![\w.])useCallback\s*\(/);
    });

    test('DOM and browser listeners use @reactuses/core hooks', () => {
        expect(source).toContain('useEventListener');
        expect(source).toContain('useResizeObserver');
        expect(source).toContain('useIsomorphicLayoutEffect');
        expect(source).toContain('useMount');
        expect(source).toContain('useUnmount');
        expect(source).not.toContain('React.useLayoutEffect');
        expect(source).not.toContain('addEventListener(');
        expect(source).not.toContain('new ResizeObserver');
    });

    test('timeline bridge publishes via render-phase refs, not effect rebinding', () => {
        expect(source).toContain('activeTurnChangeRef.current = timelineController.handleActiveTurnChange');
        expect(source).toContain('historyUpwardIntentRef.current = timelineController.handleHistoryUpwardIntent');
        expect(source).not.toMatch(
            /React\.useEffect\s*\(\s*\(\)\s*=>\s*\{\s*activeTurnChangeRef\.current\s*=/,
        );
        expect(source).not.toMatch(
            /React\.useEffect\s*\(\s*\(\)\s*=>\s*\{\s*historyUpwardIntentRef\.current\s*=/,
        );
    });
});
