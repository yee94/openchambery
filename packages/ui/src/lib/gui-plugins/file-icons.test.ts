import { describe, expect, it, vi } from 'vitest';
import { GuiPluginFileIcons } from './file-icons';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16z" fill="#abc"/></svg>';
const lightSvg = svg.replace('#abc', '#123');
const definition = { id: 'preview', extensions: ['.Eficy'], svg, lightSvg };

describe('GUI plugin file icon index', () => {
    it('normalizes extensions, chooses theme resources and never overrides directories', () => {
        const icons = new GuiPluginFileIcons();
        icons.replace('preview', [definition]);
        expect(icons.get('/work/card.EFICY')).toBe(`data:image/svg+xml,${encodeURIComponent(svg)}`);
        expect(icons.get('C:\\work\\card.eficy', { themeVariant: 'light' })).toBe(`data:image/svg+xml,${encodeURIComponent(lightSvg)}`);
        expect(icons.get('card', { extension: '.EFICY' })).toBe(icons.get('card.eficy'));
        expect(icons.get('card.eficy', { isDirectory: true, extension: 'eficy' })).toBeUndefined();
        expect(icons.get('/work.eficy/card')).toBeUndefined();
        expect(icons.get('unknown.ts')).toBeUndefined();
    });

    it('restores previous providers and ignores same-content or shadowed changes', () => {
        const icons = new GuiPluginFileIcons(), notify = vi.fn();
        icons.subscribe(notify);
        icons.replace('first', [definition]);
        icons.replace('second', [{ ...definition, svg: lightSvg }]);
        const current = icons.get('a.eficy');
        notify.mockClear();
        const encode = vi.spyOn(globalThis, 'encodeURIComponent');
        try {
            for (let i = 0; i < 50; i++) icons.replace('second', [{ ...definition, extensions: ['eficy'], svg: lightSvg }]);
            expect(encode).not.toHaveBeenCalled();
            expect(notify).not.toHaveBeenCalled();
            expect(icons.get('a.eficy')).toBe(current);
        } finally { encode.mockRestore(); }
        icons.replace('first', [{ ...definition, svg: svg.replace('#abc', '#def') }]);
        expect(notify).not.toHaveBeenCalled();
        icons.remove('second');
        expect(notify).toHaveBeenCalledTimes(1);
        expect(decodeURIComponent(icons.get('a.eficy')!)).toContain('#def');
        icons.remove('first');
        expect(icons.get('a.eficy')).toBeUndefined();
        expect(notify).toHaveBeenCalledTimes(2);
    });

    it.each([
        'https://example.com/icon.svg', '<div>icon</div>', '<svg/>',
        '<svg xmlns="http://www.w3.org/2000/svg"><path></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        svg.replace('<path ', '<path onclick="alert(1)" '),
        svg.replace('<path ', '<image href="https://example.com/icon.svg" '),
        svg.replace('<path ', '<use href="https://example.com/icon.svg#x" '),
        svg.replace('fill="#abc"', 'fill="url(https://example.com/image)"'),
        svg.replace('fill="#abc"', 'style="fill: red"'),
        '<!DOCTYPE svg>' + svg,
    ])('rejects invalid/active/external SVG without replacing existing icons: %s', (invalid) => {
        const icons = new GuiPluginFileIcons();
        icons.replace('preview', [definition]);
        const current = icons.get('a.eficy');
        expect(() => icons.replace('preview', [{ ...definition, svg: invalid }])).toThrow();
        expect(icons.get('a.eficy')).toBe(current);
        expect(() => icons.replace('preview', [{ ...definition, lightSvg: invalid }])).toThrow();
    });

    it('enforces UTF-8 byte, extension, plugin and total bounds', () => {
        const icons = new GuiPluginFileIcons();
        expect(() => icons.replace('a', [{ ...definition, svg: svg.replace('</svg>', `<desc>${'字'.repeat(6000)}</desc></svg>`) }])).toThrow('16 KiB');
        expect(() => icons.replace('a', [{ ...definition, extensions: Array.from({ length: 65 }, (_, i) => `x${i}`) }])).toThrow('1–64');
        expect(() => icons.replace('a', [{ ...definition, extensions: ['../eficy'] }])).toThrow('extension');
        const entries = Array.from({ length: 64 }, (_, i) => ({ ...definition, id: `icon${i}`, extensions: [`ext${i}`] }));
        expect(() => icons.replace('a', [...entries, { ...definition, id: 'extra' }])).toThrow('per-plugin');
        expect(() => icons.replace('a', [definition, definition])).toThrow('duplicate');
        for (let i = 0; i < 8; i++) icons.replace(`p${i}`, entries);
        expect(() => icons.replace('overflow', [definition])).toThrow('total');
        icons.dispose();
        expect(icons.get('a.ext0')).toBeUndefined();
    });
});
