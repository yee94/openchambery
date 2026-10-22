import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useVirtualizer, type ReactVirtualizer } from '@tanstack/react-virtual';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';

// Execute the production post-virtualizer boundary, as in measurementSeed.test.tsx.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MessageList.tsx'), 'utf8');
const start = source.indexOf('        initialMeasurementsCache: measurementSeedRef.current,');
const boundary = source.slice(source.indexOf('    });', start) + '    });'.length,
    source.indexOf('    useIsomorphicLayoutEffect', start));
type Virtualizer = ReactVirtualizer<HTMLDivElement, HTMLDivElement>;
type Props = { scrollRef: React.RefObject<HTMLDivElement | null>; capture: (value: Virtualizer) => void };
const compiled = ts.transpileModule(`return React.memo(function History({ scrollRef, capture }) {
    const isTanstack = true;
    const tanstackVirtualizer = useVirtualizer({
        count: 200, getScrollElement: () => scrollRef.current,
        estimateSize: () => 100, initialRect: { width: 800, height: 500 },
        observeElementRect: (_instance, callback) => { callback({ width: 800, height: 500 }); },
        scrollToFn: (offset, _options, instance) => { if (instance.scrollElement) instance.scrollElement.scrollTop = offset; },
    });
    ${boundary}
    React.useLayoutEffect(() => capture(tanstackVirtualizer));
    return React.createElement('output', null, tanstackVirtualizer.getVirtualItems().map(item => item.index).join(','));
});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const History = new Function('React', 'useVirtualizer', compiled)(React, useVirtualizer) as React.ComponentType<Props>;

test('Activity re-show reattaches memoized history after parent refs and resumes viewport updates', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const scrollRef = React.createRef<HTMLDivElement>();
    let virtualizer: Virtualizer | undefined;
    const capture = (value: Virtualizer) => { virtualizer = value; };
    const render = async (mode: 'visible' | 'hidden') => {
        await act(async () => root.render(<React.Activity mode={mode}>
            <div ref={scrollRef}><History scrollRef={scrollRef} capture={capture} /></div>
        </React.Activity>));
    };
    try {
        await render('visible');
        const scroller = scrollRef.current!;
        const instance = virtualizer!;
        Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 20000 });
        Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
        for (const offset of [4000, 9000, 2000]) {
            await render('hidden');
            expect(instance.scrollElement).toBeNull();
            expect(scrollRef.current).toBeNull();
            // Position can change while observers are disconnected.
            scroller.scrollTop = offset;
            await render('visible');
            expect(virtualizer).toBe(instance);
            expect(scrollRef.current).toBe(scroller);
            expect(instance.scrollElement).toBe(scroller);
            expect(instance.scrollOffset).toBe(offset);
            expect(instance.range?.startIndex).toBe(offset / 100);
            expect(host.querySelector('output')?.textContent?.split(',')).toContain(String(offset / 100));
            await act(async () => {
                scroller.scrollTop = offset + 1000;
                scroller.dispatchEvent(new Event('scroll'));
            });
            expect(instance.scrollOffset).toBe(offset + 1000);
            expect(instance.range?.startIndex).toBe((offset + 1000) / 100);
            expect(host.querySelector('output')?.textContent?.split(',')).toContain(String((offset + 1000) / 100));
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    }
});
