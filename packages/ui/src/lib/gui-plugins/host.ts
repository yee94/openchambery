import { batch, catchError, createComponent, createMemo, createRenderEffect, createRoot, createSignal, getOwner, onCleanup, runWithOwner, untrack, useContext as readSolidContext, type Accessor, type JSX, type Owner } from 'solid-js';
import { render } from 'solid-js/web';
import { LifetimeContext, PanelContext, PluginContext, liveAccessor } from '@opencode/plugin/gui/yuri-host';
import * as Gui from '@opencode/plugin/gui';
import type { OpenCodeClient, PluginGuiOutput } from '@yuriai/opencode-gui-client';
import type { QueryClient } from '@tanstack/react-query';
import type { FilesAPI } from '@/lib/api/types';
import { evaluateGuiBundle } from './bundle';
import { GuiPluginFiles, normalizeGuiPath } from './files';
import { GuiPluginStorage } from './storage';
import { GUI_FILE_ICON_REGISTRY, GuiPluginFileIcons } from './file-icons';
import { isLikelyFileReferencePath, parseFileReference } from '@/components/chat/fileReferenceParser';
import { toAbsoluteFilePath } from '@/lib/path-utils';

export type PluginGuiBundle = PluginGuiOutput['data'];
type Appearance = { locale: string; mode: 'light' | 'dark'; narrow: boolean };
type Options = Appearance & { client: OpenCodeClient; files: FilesAPI; queryClient: QueryClient; transport: string; storage: globalThis.Storage; focusFile?: (path: string, directory: string) => Promise<void> };
type CommandView = { key: string; title: string; description?: string; bind?: string; hidden?: boolean; run: () => void | Promise<void> };
type PanelView = { key: string; pluginId: string; title: string; active: boolean; file?: string; inline?: boolean };
export type GuiPluginSnapshot = Readonly<{
    plugins: readonly Readonly<{ id: string; revision: string; status: 'active' | 'failed'; error?: string }>[];
    commands: readonly Readonly<CommandView>[];
    panels: readonly Readonly<PanelView>[];
    settings: readonly Readonly<{ key: string; pluginId: string; title: string }>[];
    menuItems: readonly Readonly<{ key: string; title: string; description?: string; run: () => void }>[];
    activePanel: string | null;
    sessionKey?: string;
}>;
type Contribution = { registry: string; read: Accessor<unknown> };
type PanelEntry = { plugin: Instance; panel: Gui.Panel; tab: Gui.PanelTab };
type Instance = {
    id: string; revision: string; controller: AbortController; status: 'active' | 'failed'; error?: string;
    context?: Gui.SetupContext<Gui.Plugin.Definition>; owner?: Owner; root?: Owner; dispose?: () => void;
    cleanups: Set<() => void>; contributions: Set<Contribution>;
    iconChanges: ReturnType<typeof createSignal<number>>;
    commands: CommandView[]; panels: PanelEntry[]; settings: Gui.SettingsPage[]; menus: Gui.SessionPanelMenuItem[];
};
type LayoutState = { open: string[]; active: string | null; shown: boolean; scroll: Map<string, { x: number; y: number }> };
const unsupported = (name: string): never => { throw new Error(`Unsupported GUI host API: ${name}`); };
function partial<T extends object>(name: string, value: Partial<T>): T {
    // Runtime proxy makes missing capabilities fail explicitly rather than pretending to implement them.
    return new Proxy(value, { get: (target, key) => key in target ? Reflect.get(target, key) : unsupported(`${name}.${String(key)}`) }) as T;
}
const freezeRows = <T extends object>(rows: T[]) => Object.freeze(rows.map((row) => Object.freeze(row)));

function guardCleanups(owner: Owner | undefined, report: (error: unknown) => void): void {
    if (!owner) return;
    for (const child of owner.owned ?? []) guardCleanups(child, report);
    if (owner.cleanups) owner.cleanups = owner.cleanups.map((cleanup) => () => {
        try { void Promise.resolve(cleanup()).catch(report); } catch (error) { report(error); }
    });
}

export class GuiPluginHost {
    readonly fileIcons = new GuiPluginFileIcons();
    private instances = new Map<string, Instance>();
    private listeners = new Set<() => void>();
    private panelMounts = new Set<() => void>();
    private fileViews = new Map<string, number>();
    private changes = createSignal(0);
    private views = createSignal(0);
    private session = createSignal<Gui.MountedSession>();
    private appearance: ReturnType<typeof createSignal<Appearance>>;
    private layouts = new Map<string, LayoutState>();
    private files?: GuiPluginFiles;
    private storage: GuiPluginStorage;
    private ended = false;
    private contracts = new Map<string, { live: ReturnType<typeof createSignal<Gui.Live<unknown>>>; generation: number; provider?: Instance }>();
    private snapshot: GuiPluginSnapshot = Object.freeze({ plugins: Object.freeze([]), commands: Object.freeze([]), panels: Object.freeze([]), settings: Object.freeze([]), menuItems: Object.freeze([]), activePanel: null });
    private screen: Gui.SessionScreen;

    constructor(private options: Options) {
        this.appearance = createSignal<Appearance>({ locale: options.locale, mode: options.mode, narrow: options.narrow });
        this.storage = new GuiPluginStorage(options.storage, options.transport);
        const currentFile = () => { this.session[0](); return this.files?.api ?? unsupported('screen.file without a session'); };
        this.screen = partial<Gui.SessionScreen>('screen', {
            get file() { return currentFile(); },
        });
    }

    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    getSnapshot = (): GuiPluginSnapshot => this.snapshot;
    private changed() { this.changes[1]((value) => value + 1); }

    setSession(session: { id: string; directory: string } | undefined): void {
        if (this.ended) return;
        const previous = this.session[0]();
        if (previous?.id === session?.id && previous?.directory === session?.directory) return;
        if (!session) for (const stop of [...this.panelMounts]) stop();
        this.files?.dispose();
        this.files = session ? new GuiPluginFiles(this.options.files, this.options.queryClient, this.options.transport, session.directory) : undefined;
        const server = partial<Gui.ServerRef>('session.server', { id: this.options.transport, name: this.options.transport, client: this.options.client });
        const mounted = session ? Object.freeze(partial<Gui.MountedSession>('session', {
            id: session.id, directory: session.directory, key: `${this.options.transport}\n${session.id}`, tab: session.id,
            server, pending: false, visit: {}, location: { directory: session.directory },
        })) : undefined;
        this.session[1](mounted);
        this.publish();
    }

    setAppearance(input: Appearance): void {
        if (this.ended) return;
        const previous = this.appearance[0]();
        if (previous.locale === input.locale && previous.mode === input.mode && previous.narrow === input.narrow) return;
        this.appearance[1]({ ...input });
    }

    install(id: string, bundle: PluginGuiBundle): void {
        const previous = this.instances.get(id);
        if (this.ended || (previous?.status === 'active' && previous.revision === bundle.revision)) return;
        if (previous) { this.instances.delete(id); this.release(previous); }
        const instance: Instance = { id, revision: bundle.revision, controller: new AbortController(), status: 'active', cleanups: new Set(), contributions: new Set(), iconChanges: createSignal(0), commands: [], panels: [], settings: [], menus: [] };
        this.instances.set(id, instance);
        try {
            const definition = evaluateGuiBundle(bundle.code);
            createRoot((dispose) => {
                instance.dispose = dispose;
                instance.root = getOwner()!;
                catchError(() => createComponent(PluginContext.Provider, {
                    value: instance.context = this.context(instance, definition, bundle.options),
                    get children() {
                        instance.owner = getOwner()!;
                        const result: unknown = untrack(() => definition.setup!(instance.context!));
                        if (typeof result === 'function') instance.cleanups.add(() => { void Promise.resolve((result as Gui.Cleanup)()).catch((error) => { instance.error = String(error); }); });
                        else if (result !== undefined) {
                            if (result && typeof result === 'object' && 'then' in result) void Promise.resolve(result).catch(() => {});
                            throw new Error('GUI setup must be synchronous and return only cleanup');
                        }
                        return null;
                    },
                }), (error) => this.fail(instance, error));
                if (!instance.controller.signal.aborted) runWithOwner(instance.owner!, () => createRenderEffect(() => {
                    instance.iconChanges[0]();
                    if (instance.controller.signal.aborted) return;
                    try {
                        const icons = [...instance.contributions].filter((entry) => entry.registry === GUI_FILE_ICON_REGISTRY).map((entry) => entry.read()).filter((value) => value !== undefined);
                        this.fileIcons.replace(instance.id, icons);
                    } catch (error) { untrack(() => this.fail(instance, error)); }
                }));
                if (!instance.controller.signal.aborted) runWithOwner(instance.owner!, () => createRenderEffect(() => {
                    this.changes[0](); this.session[0](); this.appearance[0]();
                    try { this.derive(instance); } catch (error) { untrack(() => this.fail(instance, error)); }
                    untrack(() => this.publish());
                }));
            });
        } catch (error) { this.fail(instance, error); }
        this.changed();
        this.publish();
    }

    private release(instance: Instance): void {
        instance.controller.abort();
        for (const cleanup of [...instance.cleanups]) { try { cleanup(); } catch (error) { instance.error ??= String(error); } }
        instance.cleanups.clear();
        guardCleanups(instance.root, (error) => { instance.error ??= String(error); });
        try { instance.dispose?.(); } catch (error) { instance.error ??= String(error); }
        instance.contributions.clear(); instance.commands = []; instance.panels = []; instance.settings = []; instance.menus = [];
        this.fileIcons.remove(instance.id);
        for (const entry of this.contracts.values()) if (entry.provider === instance) {
            entry.provider = undefined;
            entry.live[1]({ status: 'inactive', reason: instance.status === 'failed' ? 'failed' : 'disabled' });
        }
    }
    private fail(instance: Instance, error: unknown): void {
        if (instance.status === 'failed' || this.instances.get(instance.id) !== instance) return;
        instance.status = 'failed'; instance.error = error instanceof Error ? error.message : String(error);
        this.release(instance); this.publish();
    }
    uninstall(id: string): void {
        const instance = this.instances.get(id);
        if (!instance) return;
        this.instances.delete(id);
        this.release(instance);
        for (const layout of this.layouts.values()) {
            layout.open = layout.open.filter((key) => !key.startsWith(`${id}:`));
            if (layout.active?.startsWith(`${id}:`)) layout.active = null;
        }
        this.changed(); this.publish();
    }
    dispose(): void {
        if (this.ended) return;
        this.ended = true;
        batch(() => { for (const id of [...this.instances.keys()]) this.uninstall(id); });
        this.files?.dispose(); this.fileIcons.dispose(); this.storage.dispose(); this.layouts.clear(); this.fileViews.clear(); this.contracts.clear(); this.listeners.clear();
    }

    private own(instance: Instance, cleanup: () => void): () => void {
        let active = true;
        const stop = () => { if (!active) return; active = false; instance.cleanups.delete(stop); cleanup(); };
        if (instance.controller.signal.aborted || readSolidContext(LifetimeContext)?.ended) { stop(); return stop; }
        instance.cleanups.add(stop);
        if (getOwner()) onCleanup(stop);
        return stop;
    }

    private list<T>(registry: Gui.Registry<T>): T[] {
        this.changes[0]();
        const result: T[] = [];
        for (const instance of this.instances.values()) {
            if (instance.status !== 'active') continue;
            for (const item of instance.contributions) if (item.registry === registry.id) {
                const value = item.read(); if (value !== undefined) result.push(value as T);
            }
        }
        return result;
    }

    private context(instance: Instance, definition: Gui.Plugin.Definition, options: Gui.PluginOptions): Gui.SetupContext<Gui.Plugin.Definition> {
        const storage = this.storage.forPlugin(instance.id, instance.controller.signal);
        const stores = Object.fromEntries(Object.entries(definition.stores ?? {}).map(([key, declaration]) => [key,
            declaration.scope === 'global' ? storage.store(key, { ...declaration, scope: 'global' }) : (session: Gui.SessionRef) => storage.store(key, { ...declaration, scope: { session } }),
        ])) as Gui.SetupContext<Gui.Plugin.Definition>['stores'];
        const t = (key: string, params?: Gui.Params) => {
            const locale = this.appearance[0]().locale;
            const text = definition.i18n?.[locale]?.[key] ?? definition.i18n?.[locale.split('-')[0]]?.[key] ?? definition.i18n?.en?.[key] ?? key;
            return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => String(params?.[name] ?? match));
        };
        const layout: Gui.Layout = partial<Gui.Layout>('layout', {
            narrow: () => this.appearance[0]().narrow, ready: () => Boolean(this.session[0]()),
            open: (key, session, options) => { if (!instance.controller.signal.aborted) this.openPanel(key, session, options); },
            close: (key, session) => { if (!instance.controller.signal.aborted) this.closeFor(key, session); },
            toggle: (key, session) => layout.state(key, session) === 'visible' ? layout.close(key, session) : layout.open(key, session),
            hide: (key, session) => { if (instance.controller.signal.aborted) return; const value = this.layout(session); if (value.active === key && value.shown) { value.shown = false; this.changed(); } },
            state: (key, session) => {
                this.changes[0](); const value = this.layout(session);
                return value.active === key ? value.shown ? 'visible' : 'active' : value.open.includes(key) ? 'open' : 'closed';
            },
            stored: (session) => { this.changes[0](); return this.layout(session).open.filter((key) => key.startsWith(`${instance.id}:`)).map((key) => key.slice(instance.id.length + 1)); },
            side: {
                opened: (session) => { this.changes[0](); return this.layout(session).shown; },
                toggle: (session) => { if (instance.controller.signal.aborted) return; const value = this.layout(session); value.shown = !value.shown; this.changed(); },
                menu: () => this.list(Gui.MenuItem).filter((item): item is Gui.SessionPanelMenuItem => item.menu === 'session.panel').sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
            },
            scroll: {
                get: (session, key) => { this.changes[0](); return this.layout(session).scroll.get(key); },
                set: (session, key, value) => { if (instance.controller.signal.aborted) return; const scroll = this.layout(session).scroll; if (!scroll.has(key) && scroll.size >= 128) throw new Error('GUI layout scroll limit exceeded'); scroll.set(key, { ...value }); this.changed(); },
            },
        });
        const context = partial<Gui.SetupContext<Gui.Plugin.Definition>>('ctx', {
            id: instance.id, options, signal: instance.controller.signal, client: this.options.client, storage, stores,
            app: { name: 'yuri', version: '', channel: 'local', platform: 'web', packaged: false }, desktop: undefined,
            t, plural: (key, count, params) => {
                const category = new Intl.PluralRules(this.appearance[0]().locale).select(count);
                const selected = `${key}.${category}`;
                return t(selected, { ...params, count }) === selected ? t(`${key}.other`, { ...params, count }) : t(selected, { ...params, count });
            },
            add: <T>(registry: Gui.Registry<T>, item: T | (() => T | undefined)) => {
                if (instance.controller.signal.aborted || readSolidContext(LifetimeContext)?.ended) return () => {};
                const unsupportedRegistries = ['server', 'titlebar-item', 'composer-pill', 'slot', 'file.viewer', 'menubar-item'];
                if (unsupportedRegistries.includes(registry.id)) unsupported(`registry.${registry.id}`);
                if (instance.contributions.size >= 256) throw new Error('GUI contribution limit exceeded');
                let dispose = () => {};
                let contributionOwner: Owner | undefined;
                const contribution = createRoot((stop) => {
                    dispose = stop;
                    contributionOwner = getOwner()!;
                    const read = createMemo(() => typeof item === 'function' ? (item as () => T | undefined)() : item);
                    if (registry.id === 'style') {
                        const style = document.createElement('style');
                        document.head.append(style);
                        onCleanup(() => style.remove());
                        createRenderEffect(() => { const value = read(); style.textContent = value === undefined ? '' : String(value); });
                    }
                    return { registry: registry.id, read };
                }, getOwner() ?? instance.owner);
                instance.contributions.add(contribution);
                const iconsChanged = () => { if (registry.id === GUI_FILE_ICON_REGISTRY) instance.iconChanges[1]((value) => value + 1); };
                untrack(iconsChanged);
                untrack(() => this.changed());
                return this.own(instance, () => { guardCleanups(contributionOwner, (error) => { instance.error ??= String(error); }); dispose(); instance.contributions.delete(contribution); untrack(iconsChanged); untrack(() => this.changed()); });
            },
            list: <T>(registry: Gui.Registry<T>) => this.list(registry),
            provide: (token, value) => {
                if (instance.controller.signal.aborted || readSolidContext(LifetimeContext)?.ended) return () => {};
                if (token.kind !== 'contract' || !(token.id === instance.id || token.id.startsWith(`${instance.id}.`))) throw new Error('Contract must belong to the providing plugin');
                const entry = this.contract(token.id);
                if (entry.provider) throw new Error(`Contract already provided: ${token.id}`);
                entry.provider = instance;
                entry.live[1]({ status: 'active', value, generation: ++entry.generation });
                return this.own(instance, () => { if (entry.provider !== instance) return; entry.provider = undefined; entry.live[1]({ status: 'inactive', reason: instance.status === 'failed' ? 'failed' : 'disabled' }); });
            },
            use: <T extends Gui.Token>(token: T) => this.contract(token.id, token.kind === 'ipc').live[0] as Accessor<Gui.Live<Gui.TokenValue<T>>>,
            main: <S extends Gui.IpcSpec>(token: Gui.Ipc<S>) => {
                if (!(token.id === instance.id || token.id.startsWith(`${instance.id}.`))) throw new Error('IPC must belong to the plugin');
                return new Proxy({ state: () => undefined }, { get: (target, key) => key === 'state' ? target.state : key === 'on' ? () => unsupported('native IPC events') : () => Promise.reject(new Error('Unsupported GUI host API: native IPC')) }) as Gui.IpcClient<S>;
            },
            sessions: { current: this.session[0], list: () => { const session = this.session[0](); return session ? [session] : []; } },
            screen: { current: () => this.session[0]() ? this.screen : undefined }, layout,
            appearance: { mode: () => this.appearance[0]().mode, font: () => getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace' },
            locale: { locale: () => this.appearance[0]().locale, direction: () => /^(ar|fa|he|ur)(-|$)/i.test(this.appearance[0]().locale) ? 'rtl' : 'ltr' },
            system: {
                copy: (text) => navigator.clipboard.writeText(text),
                openExternal: (url) => { const parsed = new URL(url); if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) unsupported('system.openExternal protocol'); window.open(url, '_blank', 'noopener,noreferrer'); },
                save: async (file) => { const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain' })); try { const link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); return true; } finally { setTimeout(() => URL.revokeObjectURL(url), 0); } },
            },
            commands: { run: (key) => { if (instance.controller.signal.aborted || !this.command(key)) return false; void this.runCommand(key); return true; } },
            links: { open: (link) => !instance.controller.signal.aborted && this.navigateLink(instance, link), exists: (link) => untrack(() => { if (instance.controller.signal.aborted) return false; const handler = this.linkHandler(link); try { return Promise.resolve(handler?.value.exists?.(link) ?? false).catch(() => false); } catch { return false; } }) },
        });
        return context;
    }

    private contract(id: string, ipc = false) {
        let entry = this.contracts.get(id);
        if (!entry) {
            if (this.contracts.size >= 256) throw new Error('GUI contract limit exceeded');
            const live = createSignal<Gui.Live<unknown>>({ status: 'inactive', reason: 'disabled' });
            entry = { live: [liveAccessor(live[0]), live[1]], generation: 0 };
            this.contracts.set(id, entry);
        }
        if (ipc && entry.provider) unsupported('IPC contract collision');
        return entry;
    }

    private derive(instance: Instance): void {
        if (instance.status !== 'active') return;
        const commands: CommandView[] = [], panels: PanelEntry[] = [], settings: Gui.SettingsPage[] = [], menus: Gui.SessionPanelMenuItem[] = [];
        const session = this.session[0]();
        for (const contribution of instance.contributions) {
            if (contribution.registry === GUI_FILE_ICON_REGISTRY) continue;
            const value = contribution.read(); if (value === undefined) continue;
            if (contribution.registry === Gui.Command.id) {
                const command = value as Gui.Command;
                if (command.enabled !== false) commands.push({ key: `${instance.id}.${command.id}`, title: command.title, description: command.description, bind: command.bind, hidden: command.hidden, run: () => this.invoke(instance, () => command.run()) });
            } else if (contribution.registry === Gui.Panel.id && session) {
                const panel = value as Gui.Panel;
                const prefix = `${instance.id}:`;
                const open = this.layout(session).open.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
                for (const tab of panel.list({ session, screen: this.screen, open })) panels.push({ plugin: instance, panel, tab });
            } else if (contribution.registry === Gui.SettingsPage.id) {
                const page = value as Gui.SettingsPage;
                if (page.page || page.section) unsupported('SettingsPage host sections');
                // Access labels here so their getters are tracked by the plugin's derivation.
                void page.title; settings.push(page);
            } else if (contribution.registry === Gui.MenuItem.id) {
                const menu = value as Gui.MenuItem;
                if (menu.menu !== 'session.panel') { unsupported(`MenuItem.${menu.menu}`); }
                else { void menu.title; menus.push(menu); }
            }
        }
        for (const entry of panels) void entry.tab.title;
        instance.commands = commands; instance.panels = panels; instance.settings = settings; instance.menus = menus;
        untrack(() => this.views[1]((value) => value + 1));
    }

    private publish(): void {
        const session = untrack(this.session[0]);
        const layout = session ? this.layouts.get(session.key) : undefined;
        const instances = [...this.instances.values()];
        const active = instances.filter((instance) => instance.status === 'active');
        const panels = active.flatMap((instance) => instance.panels.map(({ tab }) => {
            const file = tab.file ? this.filePath(tab.file) : undefined;
            return { key: `${instance.id}:${tab.id}`, pluginId: instance.id, title: tab.title, file, inline: Boolean(file && this.fileViews.has(file)), active: layout?.shown === true && layout.active === `${instance.id}:${tab.id}` };
        }));
        this.snapshot = Object.freeze({
            plugins: freezeRows(instances.map(({ id, revision, status, error }) => ({ id, revision, status, error }))),
            commands: freezeRows(active.flatMap((instance) => instance.commands.filter((command) => !command.hidden))), panels: freezeRows(panels),
            settings: freezeRows(active.flatMap((instance) => instance.settings.map((page) => ({ key: `${instance.id}:${page.id}`, pluginId: instance.id, title: page.title })))),
            menuItems: freezeRows(active.flatMap((instance) => instance.menus.map((menu) => ({ key: `${instance.id}:${menu.id}`, title: menu.title, description: menu.description, run: () => { void this.invoke(instance, () => menu.run()); } })))),
            activePanel: layout?.shown && panels.some((panel) => panel.key === layout.active) ? layout.active : null,
            sessionKey: session?.key,
        });
        for (const listener of this.listeners) listener();
    }

    private invoke(instance: Instance, action: () => void | false | Promise<void>): void | Promise<void> {
        if (instance.controller.signal.aborted) return;
        try {
            const result = runWithOwner(instance.owner ?? null, action);
            if (result instanceof Promise) return result.catch((error) => this.fail(instance, error));
        } catch (error) { this.fail(instance, error); }
    }
    private command(key: string): CommandView | undefined { return [...this.instances.values()].flatMap((instance) => instance.commands).find((command) => command.key === key); }
    runCommand(key: string): void | Promise<void> { return this.command(key)?.run(); }
    private linkHandler(link: Gui.Link): { instance: Instance; value: Gui.LinkHandler } | undefined {
        const handlers: { instance: Instance; value: Gui.LinkHandler }[] = [];
        for (const instance of this.instances.values()) for (const entry of instance.contributions) if (entry.registry === Gui.LinkHandler.id) {
            const value = entry.read() as Gui.LinkHandler | undefined;
            if (value) handlers.push({ instance, value });
        }
        for (const handler of handlers.sort((a, b) => (b.value.priority ?? 0) - (a.value.priority ?? 0))) {
            try { if (handler.value.match(link)) return handler; } catch (error) { this.fail(handler.instance, error); }
        }
    }
    private navigateLink(instance: Instance, link: Gui.Link): boolean {
        if (this.ended) return false;
        const parsed = parseFileReference(link.href);
        if (!parsed || !isLikelyFileReferencePath(parsed.path)) return this.openLink(link);
        const session = this.session[0]();
        if (!session || (link.session && (link.session.key !== session.key || link.session.server.id !== session.server.id))) return false;
        if (!this.options.focusFile) return this.openLink(link);
        const path = toAbsoluteFilePath(link.base ?? session.directory, parsed.path);
        const suffix = parsed.line === undefined ? '' : `:${parsed.line}${parsed.column === undefined ? '' : `:${parsed.column}`}`;
        // The owning file surface registers its lease and dispatches the handler after navigation.
        void this.invoke(instance, () => this.options.focusFile!(path + suffix, session.directory));
        return true;
    }

    openLink(link: Gui.Link): boolean {
        if (this.ended) return false;
        const input = { ...link, session: link.session ?? this.session[0]() };
        const handler = this.linkHandler(input);
        if (!handler) return false;
        void this.invoke(handler.instance, () => handler.value.open(input)); return true;
    }

    private filePath(path: string, base = this.session[0]()?.directory): string {
        const normalized = normalizeGuiPath(path);
        return /^(?:\/|[a-z]:\/)/i.test(normalized) || !base ? normalized : normalizeGuiPath(`${base}/${normalized}`);
    }

    /** A displayed file view owns presentation before its LinkHandler opens a tab. */
    registerFileView(path: string, base?: string): () => void {
        if (this.ended) return () => {};
        const file = this.filePath(path, base);
        const count = this.fileViews.get(file) ?? 0;
        this.fileViews.set(file, count + 1);
        if (count === 0) { this.changed(); this.publish(); }
        let released = false;
        return () => {
            if (released || this.ended) return;
            released = true;
            const remaining = (this.fileViews.get(file) ?? 1) - 1;
            if (remaining) { this.fileViews.set(file, remaining); return; }
            else {
                // Closing/switching the file must not turn its preview into a modal.
                const session = this.session[0]();
                const layout = session && this.layouts.get(session.key);
                if (layout?.active && this.snapshot.panels.some((panel) => panel.key === layout.active && panel.file === file)) layout.shown = false;
                this.fileViews.delete(file);
            }
            this.changed(); this.publish();
        };
    }

    filePanel(path: string, base?: string): Readonly<PanelView> | undefined {
        const file = this.filePath(path, base);
        return this.snapshot.panels.find((panel) => panel.file === file && panel.inline);
    }

    private panelVisible(key: string): boolean {
        const session = this.session[0]();
        if (!session) return false;
        const file = this.panel(key)?.tab.file;
        if (file && this.fileViews.has(this.filePath(file))) return true;
        const layout = this.layouts.get(session.key);
        return Boolean(layout?.shown && layout.active === key);
    }

    private layout(session: Gui.SessionRef): LayoutState {
        let value = this.layouts.get(session.key);
        if (!value) {
            if (this.layouts.size >= 128) throw new Error('GUI session layout limit exceeded');
            value = { open: [], active: null, shown: false, scroll: new Map() }; this.layouts.set(session.key, value);
        }
        return value;
    }
    private openPanel(key: string, session: Gui.SessionRef, options?: Gui.OpenOptions): void {
        if (this.ended) return;
        const layout = this.layout(session);
        const previousActive = layout.active, previousShown = layout.shown, previousLength = layout.open.length;
        if (!layout.open.includes(key)) { if (layout.open.length >= 64) throw new Error('GUI panel tab limit exceeded'); layout.open = [...layout.open, key]; }
        if (options?.tab !== 'append') { layout.active = key; layout.shown = !(this.appearance[0]().narrow && options?.background); }
        if (previousActive !== layout.active || previousShown !== layout.shown || previousLength !== layout.open.length) { this.changed(); this.publish(); }
        const entry = this.panel(key);
        if (session.key === this.session[0]()?.key && entry && options?.tab !== 'append') void this.invoke(entry.plugin, () => entry.panel.focus?.({ ...this.props(key), restored: false }));
    }
    selectPanel(key: string): void { const session = this.session[0](); if (session) this.openPanel(key, session); }
    private closeFor(key: string, session: Gui.SessionRef): void {
        const layout = this.layout(session), entry = session.key === this.session[0]()?.key ? this.panel(key) : undefined;
        if (!layout.open.includes(key)) return;
        if (entry?.tab.pinned || entry?.tab.closable === false) return;
        const current = this.session[0]();
        const props = entry && current ? { tab: entry.tab, session: current, screen: this.screen } : undefined;
        layout.open = layout.open.filter((item) => item !== key);
        if (layout.active === key) layout.active = layout.open.at(-1) ?? null;
        this.changed(); this.publish();
        if (entry && props) void this.invoke(entry.plugin, () => entry.panel.close?.(props));
    }
    closePanel(key: string): void { const session = this.session[0](); if (session) this.closeFor(key, session); }
    hidePanel(): void { const session = this.session[0](); if (!session) return; const layout = this.layout(session); if (!layout.shown) return; layout.shown = false; this.changed(); this.publish(); }
    private panel(key: string): PanelEntry | undefined { return [...this.instances.values()].flatMap((instance) => instance.panels).find((entry) => `${entry.plugin.id}:${entry.tab.id}` === key); }
    private props(key: string): Gui.PanelProps {
        const initial = this.panel(key)?.tab;
        const currentTab = () => { this.views[0](); return this.panel(key)?.tab ?? initial ?? unsupported('panel no longer listed'); };
        const currentSession = () => this.session[0]() ?? unsupported('panel without session');
        return { get tab() { return currentTab(); }, get session() { return currentSession(); }, screen: this.screen };
    }
    mountPanel(key: string, element: HTMLElement): () => void {
        const entry = this.panel(key);
        if (!entry) return () => {};
        const renderPanel = () => {
            const watched = createMemo(() => {
                this.session[0](); this.changes[0](); this.views[0]();
                const file = this.panel(key)?.tab.file;
                return file && this.files && this.panelVisible(key) ? { model: this.files, file } : undefined;
            }, undefined, { equals: (a, b) => a?.model === b?.model && a?.file === b?.file });
            createRenderEffect(() => {
                const value = watched();
                if (!value) return;
                onCleanup(value.model.watch(value.file));
                void value.model.sync(value.file).catch(() => {});
            });
            return untrack(() => entry.panel.render(this.props(key)));
        };
        const stop = this.mount(entry.plugin, element, () => createComponent(PanelContext.Provider, {
            value: {
                visible: () => { this.changes[0](); return this.panelVisible(key); },
                present: () => { this.changes[0](); return this.panelVisible(key); },
                placement: () => this.appearance[0]().narrow ? 'mobile' : 'side', reserve: () => false, animate: () => false,
                sidebar: partial<Gui.PanelSidebar>('panel.sidebar', {}),
                open: () => { const session = this.session[0](); return session ? entry.plugin.context!.layout.stored(session) : []; },
            },
            get children() { return renderPanel(); },
        }));
        const tracked = () => { this.panelMounts.delete(tracked); stop(); };
        this.panelMounts.add(tracked);
        return this.own(entry.plugin, tracked);
    }
    mountSettings(key: string, element: HTMLElement): () => void {
        for (const instance of this.instances.values()) {
            const page = instance.settings.find((page) => `${instance.id}:${page.id}` === key);
            if (page) return this.mount(instance, element, () => page.render({}));
        }
        return () => {};
    }
    private mount(instance: Instance, element: HTMLElement, view: () => JSX.Element): () => void {
        if (instance.controller.signal.aborted) return () => {};
        let dispose = () => {};
        let owner: Owner | undefined;
        const report = (error: unknown) => { queueMicrotask(() => this.fail(instance, error)); };
        try {
            dispose = render(() => createComponent(PluginContext.Provider, {
                value: instance.context!,
                get children() { owner = getOwner()!; return catchError(() => untrack(view), report); },
            }), element);
        } catch (error) { this.fail(instance, error); }
        return this.own(instance, () => { guardCleanups(owner, (error) => { instance.error ??= String(error); }); dispose(); element.replaceChildren(); });
    }
}
