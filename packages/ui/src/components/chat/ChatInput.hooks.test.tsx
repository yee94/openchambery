import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useEvent, useEventListener } from '@reactuses/core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { buildHighlightParts, mentionRangesToHighlightRanges, tokenizeMarkdown } from './composerHighlight';
import { highlightFencedCode } from './composerCodeHighlight';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ChatInput.tsx'), 'utf8');
const ast = ts.createSourceFile('ChatInput.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, string>();
let resizeListener = '';
let dictationTailEffect = '';
let primaryCatalog = '';
let modelControls = '';
const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(ast), `const ${node.getText(ast)};`);
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEventListener'
        && node.arguments[1]?.getText(ast) === 'updateAutocompleteOverlayPosition') resizeListener = `${node.getText(ast)};`;
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'React.useLayoutEffect'
        && node.getText(ast).includes('textarea.scrollTop = textarea.scrollHeight')) dictationTailEffect = `${node.getText(ast)};`;
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'primarySurface') {
        const call = node.initializer as ts.CallExpression;
        const value = call.arguments[0] as ts.ObjectLiteralExpression;
        const selection = value.properties.find(prop => prop.name?.getText(ast) === 'selection') as ts.PropertyAssignment;
        const catalog = (selection.initializer as ts.ObjectLiteralExpression).properties.find(prop => prop.name?.getText(ast) === 'catalog') as ts.PropertyAssignment;
        primaryCatalog = catalog.initializer.getText(ast);
    }
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'MemoModelControls'
        && node.getText(ast).includes('min-w-0 flex-1 justify-end')) modelControls = node.getText(ast);
    ts.forEachChild(node, visit);
};
visit(ast);

function surface<Props extends object>(body: string, scope: Record<string, unknown>): React.ComponentType<Props> {
    const compiled = ts.transpileModule(`const Surface = (props) => { ${body} };`, {
        compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    return new Function('React', 'useEvent', 'useEventListener', ...Object.keys(scope), `${compiled}\nreturn Surface;`)(React, useEvent, useEventListener, ...Object.values(scope));
}
const host = document.createElement('div');
const root = createRoot(host);
afterEach(async () => { await act(async () => root.render(null)); vi.restoreAllMocks(); });

it.each([
    [true, true, 'primary', true, false],
    [false, true, 'primary', false, true],
    [true, false, 'primary', false, true],
    [true, true, 'secondary', false, true],
])('native input takes precedence over hold-to-talk (%s/%s/%s)', (enabled, supported, kind, native, holdToTalk) => {
    const dictation = [...declarations].find(([name]) => name.includes('globallyEnabled: dictationEnabled'))?.[1];
    expect(dictation).toBeDefined();
    const evaluate = new Function('iosNativeUiEnabled', 'canUseNativeIosComposer', 'surface', 'isMobile', 'useHoldToTalkInput', `
        ${declarations.get('nativeComposerOwnedInput')}
        ${dictation}
        return { native: nativeComposerOwnedInput, holdToTalk: holdToTalkEnabled };
    `);
    expect(evaluate(enabled, () => supported, { kind }, true, ({ available }: { available: boolean }) => ({
        globallyEnabled: true, enabled: available, hint: null, onHintChange: () => undefined,
    }))).toEqual({ native, holdToTalk });
});

it.each([
    [false, false, false, 1],
    [true, false, false, 0],
    [false, true, false, 0],
    [false, false, true, 0],
])('session reference selection keeps necessary loading and gates history prefetch (%s/%s/%s)', async (mobile, capacitor, hosted, expected) => {
    const ensure = vi.fn(async () => undefined);
    const prefetch = vi.fn(async () => undefined);
    const inserted = vi.fn(() => ({ document: { text: '@session ' }, caret: 9 }));
    let select!: (session: { id: string }) => void;
    const Surface = surface(`
        ${declarations.get('handleSessionSelect')}
        capture(handleSessionSelect);
        return null;
    `, {
        isMobile: mobile, isCapacitorApp: () => capacitor, isMobileSurfaceRuntime: () => hosted,
        pendingSessionReferenceRef: { current: false },
        useSessionUIStore: { getState: () => ({ getAuthoritativeDirectoryForSession: () => '/repo' }) },
        ensureSessionRenderable: ensure, resolveMaterializedSessionDirectory: () => '/repo',
        ensureSessionMentionTranscripts: prefetch, getDocument: () => ({ text: '@' }),
        readComposerInsertCaret: () => 1, resolveComposerAutocompleteReplaceRange: () => null,
        autocompleteTriggerRef: { current: null }, getAllSyncSessionMap: () => new Map(),
        createUuid: () => 'id', composerTriggerIconDisplay: () => '@session', insertReference: inserted,
        advancePastTrailingBoundarySpace: (_text: string, caret: number) => caret,
        cursorPosRef: { current: 0 }, requestAnimationFrame: () => 0,
        setShowFileMention: vi.fn(), setMentionQuery: vi.fn(), restoreWebComposerFocus: vi.fn(),
        toast: { error: vi.fn() }, t: (key: string) => key,
        capture: (value: typeof select) => { select = value; },
    });
    await act(async () => root.render(<Surface />));
    await act(async () => select({ id: 'ses_reference' }));
    expect(ensure).toHaveBeenCalledWith('ses_reference', { directory: '/repo' });
    expect(inserted).toHaveBeenCalledOnce();
    expect(prefetch).toHaveBeenCalledTimes(expected);
});

it('keeps pasted Markdown literal without a highlight overlay across repeated draft edits', async () => {
    const markdown = vi.fn(tokenizeMarkdown);
    const code = vi.fn(highlightFencedCode);
    let highlighted!: ReturnType<typeof buildHighlightParts>;
    const Surface = surface<{ message: string; mention?: boolean }>(`
        const { message } = props;
        const composerMentionRanges = props.mention ? [{ start: 0, end: 7, kind: 'file' }] : [];
        ${declarations.get('highlightedComposerContent')}
        capture(highlightedComposerContent);
        return null;
    `, {
        inputMode: 'normal', nativeComposerOwnedInput: false,
        tokenizeMarkdown: markdown, highlightFencedCode: code,
        buildHighlightParts, mentionRangesToHighlightRanges,
        composerCommandRanges: [], attachmentCitationRanges: [],
        composerDocument: { references: [] }, desktopDictationPreview: null, primaryDraftKeyID: 'draft',
        capture: (value: typeof highlighted) => { highlighted = value; },
    });
    const text = '# 标题\n**重点** `inline` [链接](https://example.com)\n> 引用\n- 列表\n```js\nconst value = 1;\n```\n';
    for (let i = 1; i <= 50; i++) {
        await act(async () => root.render(<Surface message={text.repeat(i)} />));
        expect(highlighted).toBeNull();
    }
    expect(markdown).not.toHaveBeenCalled();
    expect(code).not.toHaveBeenCalled();
    const withMention = '@src.ts ' + text;
    await act(async () => root.render(<Surface message={withMention} mention />));
    expect(highlighted!.map(part => part.text).join('')).toBe(withMention);
    expect(highlighted![0].className).toBe('text-[var(--primary)]');
    expect(highlighted!.slice(1).every(part => part.className === 'text-foreground')).toBe(true);
});

it('keeps model-control Hooks asleep through 50 draft edits and delivers the latest selection callback', async () => {
    let evaluations = 0;
    let latest: { onChange: (selection: object) => Promise<void>; catalog: { providers: unknown[] } };
    const MemoModelControls = React.memo((props: { selectionAdapter: typeof latest }) => {
        evaluations++;
        latest = props.selectionAdapter;
        return null;
    });
    const Surface = surface<{ onChange: (value: object) => void; providers: unknown[]; active: boolean }>(`
        const primarySelectionProviders = props.providers;
        const primarySelectionAgents = agents;
        const primarySelectionVariants = variants;
        const primaryProviderConfigLoading = false;
        const primaryAgentConfigLoading = false;
        ${declarations.get('primarySelectionCatalog') ?? ''}
        const selectionCatalog = ${primaryCatalog};
        const selectionValue = { providerID: 'provider', modelID: 'model', agent: 'build' };
        const selectionChange = props.onChange;
        const surface = { active: props.active };
        ${declarations.get('handleModelControlsSelectionChange') ?? ''}
        ${declarations.get('modelControlsSelectionAdapter')}
        return ${modelControls};
    `, { MemoModelControls, agents: [], variants: [], textareaRef: { current: null } });
    const providers = Array.from({ length: 300 }, (_, id) => ({ id: String(id) }));
    let received = -1;
    await act(async () => root.render(<Surface providers={providers} active onChange={() => { received = 0; }} />));
    const initialEvaluations = evaluations;
    for (let i = 1; i <= 50; i++) {
        await act(async () => root.render(<Surface providers={providers} active onChange={() => { received = i; }} />));
    }
    expect(evaluations).toBe(initialEvaluations);
    await latest!.onChange({ providerID: 'provider', modelID: 'other', agent: 'build' });
    expect(received).toBe(50);
    const updated = [...providers, { id: 'new' }];
    await act(async () => root.render(<Surface providers={updated} active onChange={() => { received = 51; }} />));
    expect(latest!.catalog.providers).toBe(updated);
    expect(evaluations).toBe(initialEvaluations + 1);
    await act(async () => root.render(<Surface providers={updated} active={false} onChange={() => { received = 52; }} />));
    expect(evaluations).toBe(initialEvaluations + 2);
});

it('does not flash an inbox chip for a direct send already painted in the transcript', async () => {
    const Surface = surface<{ messages: { id: string }[]; inbox: { id: string }[] }>(`
        const primarySessionMessages = props.messages;
        const inboxOverlayItems = props.inbox;
        ${declarations.get('inboxOverlayChips')}
        return React.createElement('span', null, inboxOverlayChips.map((item) => item.messageID).join(','));
    `, { toInboxChip: (item: { id: string }) => ({ messageID: item.id }), EMPTY_INBOX_CHIPS: [] });
    const messages = [{ id: 'direct-send' }];
    await act(async () => root.render(<Surface messages={messages} inbox={[]} />));
    expect(host.textContent).toBe('');
    // HTTP admission / enqueue SSE can arrive before the consumed receipt.
    await act(async () => root.render(<Surface messages={messages} inbox={[{ id: 'direct-send' }]} />));
    expect(host.textContent).toBe('');
    await act(async () => root.render(<Surface messages={messages} inbox={[{ id: 'direct-send' }, { id: 'waiting' }]} />));
    expect(host.textContent).toBe('waiting');
    await act(async () => root.render(<Surface messages={[...messages, { id: 'waiting' }]} inbox={[{ id: 'waiting' }]} />));
    expect(host.textContent).toBe('');
    // A genuinely pending item without a transcript row remains recoverable.
    await act(async () => root.render(<Surface messages={[]} inbox={[{ id: 'waiting' }]} />));
    expect(host.textContent).toBe('waiting');
});

it('follows mobile ASR text and its underline to the bottom without focusing or resizing', async () => {
    expect(dictationTailEffect).not.toBe('');
    const textarea = document.createElement('textarea');
    const highlight = document.createElement('div');
    textarea.style.height = '48px';
    let contentHeight = 48;
    Object.defineProperty(textarea, 'scrollHeight', { get: () => contentHeight });
    const focus = vi.spyOn(textarea, 'focus');
    const Surface = surface<{ isMobile: boolean; mobileDictationActive: boolean; message: string }>(`
        const { isMobile, mobileDictationActive, message } = props;
        ${dictationTailEffect}
        return null;
    `, { textareaRef: { current: textarea }, composerHighlightRef: { current: highlight } });
    for (let i = 1; i <= 50; i++) {
        contentHeight = 48 + i * 20;
        await act(async () => root.render(<Surface isMobile mobileDictationActive message={'转写\n'.repeat(i)} />));
        expect(textarea.scrollTop).toBe(contentHeight);
        expect(highlight.style.transform).toBe(`translateY(-${textarea.scrollTop}px)`);
        expect(textarea.style.height).toBe('48px');
    }
    expect(focus).not.toHaveBeenCalled();
    for (const mode of [{ isMobile: false, mobileDictationActive: true }, { isMobile: true, mobileDictationActive: false }]) {
        textarea.scrollTop = 12;
        await act(async () => root.render(<Surface {...mode} message="普通输入" />));
        expect(textarea.scrollTop).toBe(12);
    }
});

it('selects the new draft during render and retains selector identity across unrelated renders', async () => {
    const state = { drafts: { a: { text: 'first' }, b: { text: 'second' } } };
    type Selector = (value: typeof state) => { text: string } | undefined;
    const selectors: Selector[] = [];
    const Surface = surface<{ draft: string }>(`
        const primaryDraftKeyID = props.draft;
        ${declarations.get('primaryDraftRecord')}
        return React.createElement('span', null, primaryDraftRecord?.text);
    `, { useInputStore: (selector: Selector) => { selectors.push(selector); return selector(state); } });
    await act(async () => root.render(<Surface draft="a" />));
    const firstSelector = selectors.at(-1);
    for (let i = 0; i < 50; i++) await act(async () => root.render(<Surface draft="a" />));
    expect(selectors.every((selector) => selector === firstSelector)).toBe(true);
    await act(async () => root.render(<Surface draft="b" />));
    expect(host.textContent).toBe('second');
    expect(selectors.at(-1)).not.toBe(firstSelector);
});

it('retains the autocomplete resize listener across typing and reads the latest event-time state', async () => {
    expect(resizeListener).not.toBe('');
    const setPosition = vi.fn();
    const Surface = surface<{ expanded: boolean; message: string; show: boolean }>(`
        const { expanded: isDesktopExpanded, message, show: showFileMention } = props;
        const showCommandAutocomplete = false;
        ${declarations.get('updateAutocompleteOverlayPosition')}
        ${resizeListener}
        return null;
    `, {
        setAutocompleteOverlayPosition: setPosition,
        textareaRef: { current: { selectionStart: 0, scrollTop: 0, scrollLeft: 0, getBoundingClientRect: () => ({ top: 0, left: 0 }) } },
        dropZoneRef: { current: { getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600 }) } },
        measureCaretInTextarea: () => ({ top: 30, left: 40 }),
    });
    await act(async () => root.render(<Surface expanded message="" show={false} />));
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    for (let i = 0; i < 50; i++) await act(async () => root.render(<Surface expanded message={'x'.repeat(i)} show={false} />));
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    await act(async () => root.render(<Surface expanded message="@file" show />));
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ place: 'below' }));
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    await act(async () => root.render(<Surface expanded={false} message="@file" show />));
    expect(remove.mock.calls.map(([type]) => String(type))).toContain('resize');
    setPosition.mockClear();
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(setPosition).not.toHaveBeenCalled();
});
