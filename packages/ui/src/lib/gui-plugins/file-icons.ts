export const GUI_FILE_ICON_REGISTRY = 'yuri.file-icon';

export type GuiPluginFileIconDefinition = {
    id: string;
    extensions: readonly string[];
    svg: string;
    lightSvg?: string;
};
type Image = { source: string; uri: string; bytes: number };
type Icon = { id: string; extensions: string[]; dark: Image; light: Image };
type Options = { extension?: string; themeVariant?: 'light' | 'dark'; isDirectory?: boolean };
const namespace = 'http://www.w3.org/2000/svg';
const elements = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'use', 'title', 'desc']);
const extensionKey = (value: string) => value.trim().replace(/^\./, '').toLowerCase();

function image(source: unknown, previous: Map<string, Image>): Image {
    if (typeof source !== 'string') throw new Error('GUI file icon requires SVG text');
    const cached = previous.get(source);
    if (cached) return cached;
    if (source.length > 16 * 1024) throw new Error('GUI file icon SVG exceeds 16 KiB');
    const bytes = new TextEncoder().encode(source).byteLength;
    if (bytes > 16 * 1024) throw new Error('GUI file icon SVG exceeds 16 KiB');
    if (!/^\s*<svg[\s>]/.test(source) || /<!|<\?/.test(source)) throw new Error('Invalid GUI file icon SVG');
    const document = new DOMParser().parseFromString(source, 'image/svg+xml');
    const root = document.documentElement;
    if (root?.localName !== 'svg' || root.namespaceURI !== namespace || document.querySelector('parsererror')) throw new Error('Invalid GUI file icon SVG');
    for (const element of [root, ...root.querySelectorAll('*')]) {
        if (element.namespaceURI !== namespace || !elements.has(element.localName)) throw new Error('Unsupported GUI file icon SVG element');
        for (const attribute of element.attributes) {
            const name = attribute.name.toLowerCase(), value = attribute.value.trim();
            if (name.startsWith('on') || name === 'style' || name === 'xml:base' || value.includes('\\') || Array.from(value).some((character) => character.charCodeAt(0) < 32)
                || (name === 'href' || name.endsWith(':href')) && !/^#[\w.-]+$/.test(value)
                || /url\s*\(/i.test(value) && !/^url\(\s*#[\w.-]+\s*\)$/.test(value)) {
                throw new Error('Unsupported GUI file icon SVG reference or attribute');
            }
        }
    }
    const result = { source, bytes, uri: `data:image/svg+xml,${encodeURIComponent(source)}` };
    previous.set(source, result);
    return result;
}

/** Window-owned, bounded icon index; subscriptions are independent of host snapshots. */
export class GuiPluginFileIcons {
    private plugins = new Map<string, Icon[]>();
    private index = new Map<string, Icon>();
    private listeners = new Set<() => void>();

    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

    get(filePath: string, options?: Options): string | undefined {
        if (options?.isDirectory) return undefined;
        const name = filePath.split(/[\\/]/).at(-1) ?? '';
        const extension = options?.extension ?? (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '');
        const icon = this.index.get(extensionKey(extension));
        return options?.themeVariant === 'light' ? icon?.light.uri : icon?.dark.uri;
    }

    replace(pluginId: string, definitions: readonly unknown[]): void {
        if (definitions.length > 64) throw new Error('GUI file icon per-plugin limit exceeded');
        if (!definitions.length) { this.remove(pluginId); return; }
        const previous = new Map<string, Image>();
        for (const icon of this.plugins.get(pluginId) ?? []) for (const asset of [icon.dark, icon.light]) previous.set(asset.source, asset);
        const ids = new Set<string>();
        const icons = definitions.map((input): Icon => {
            if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 128 || ids.has(input.id)) throw new Error('Invalid or duplicate GUI file icon id');
            ids.add(input.id);
            if (!('extensions' in input) || !Array.isArray(input.extensions) || !input.extensions.length || input.extensions.length > 64) throw new Error('GUI file icon requires 1–64 extensions');
            const extensions = input.extensions.map((extension: unknown) => {
                if (typeof extension !== 'string') throw new Error('Invalid GUI file icon extension');
                const key = extensionKey(extension);
                if (!/^[a-z0-9][a-z0-9_+-]{0,63}$/.test(key)) throw new Error('Invalid GUI file icon extension');
                return key;
            });
            const dark = image('svg' in input ? input.svg : undefined, previous);
            const light = 'lightSvg' in input && input.lightSvg !== undefined ? image(input.lightSvg, previous) : dark;
            return { id: input.id, extensions: [...new Set(extensions)], dark, light };
        });
        let count = icons.length, bytes = icons.reduce((sum, icon) => sum + icon.dark.bytes + icon.light.bytes, 0);
        for (const [id, entries] of this.plugins) if (id !== pluginId) {
            count += entries.length;
            bytes += entries.reduce((sum, icon) => sum + icon.dark.bytes + icon.light.bytes, 0);
        }
        if (count > 512 || bytes > 8 * 1024 * 1024) throw new Error('GUI file icon total limit exceeded');
        this.plugins.set(pluginId, icons);
        this.publish();
    }

    remove(pluginId: string): void { if (this.plugins.delete(pluginId)) this.publish(); }

    dispose(): void { this.plugins.clear(); this.publish(); this.listeners.clear(); }

    private publish(): void {
        const next = new Map<string, Icon>();
        for (const icons of this.plugins.values()) for (const icon of icons) for (const extension of icon.extensions) next.set(extension, icon);
        const changed = next.size !== this.index.size || [...next].some(([key, icon]) => {
            const previous = this.index.get(key);
            return previous?.dark.uri !== icon.dark.uri || previous?.light.uri !== icon.light.uri;
        });
        this.index = next;
        if (changed) for (const listener of this.listeners) listener();
    }
}
