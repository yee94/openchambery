import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEvent } from '@reactuses/core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { DesktopDictationButton } from './DesktopDictationButton';

const mock = vi.hoisted(() => ({
    onTranscript: (_text: string) => {},
    onPartial: (_text: string) => {},
    hookWork: vi.fn(),
    toastError: vi.fn(), toastDismiss: vi.fn(),
    dictation: { status: 'idle', isStarting: false, error: null as string | null,
        startDictation: vi.fn(), confirmDictation: vi.fn(), retryFailedDictation: vi.fn(), cancelDictation: vi.fn(), discardFailedDictation: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { error: mock.toastError, dismiss: mock.toastDismiss } }));
vi.mock('@/hooks/useDictation', () => ({ useDictation: (options: { onTranscript: (text: string) => void; onPartialTranscript: (text: string) => void }) => {
    mock.hookWork();
    mock.onTranscript = options.onTranscript;
    mock.onPartial = options.onPartialTranscript;
    return mock.dictation;
} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const insert = vi.fn();
const partial = vi.fn();
const start = vi.fn();
const cancel = vi.fn();
const recordingChange = vi.fn();
const inputRef = { current: null as HTMLTextAreaElement | null };
const render = async (interactionMode: 'desktop' | 'mobile' = 'desktop') => { await act(async () => root.render(<DesktopDictationButton interactionMode={interactionMode} inputRef={inputRef} onRecordingChange={recordingChange} onInsert={insert} onPartial={partial} onStart={start} onCancel={cancel} />)); };
const button = () => host.querySelector('button')!;
beforeEach(async () => {
    vi.clearAllMocks();
    Object.assign(mock.dictation, { status: 'idle', error: null });
    host = document.createElement('div'); document.body.append(host);
    root = createRoot(host); await render();
    inputRef.current = document.createElement('textarea'); host.append(inputRef.current);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it.each(['desktop', 'mobile'] as const)('%s keeps dictation hook work off repeated composer edits while final insertion sees the latest draft', async (mode) => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../chat/ChatInput.tsx'), 'utf8');
    const ast = ts.createSourceFile('ChatInput.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declarations = new Map<string, string>();
    let buttonJsx = '';
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            if (['MemoDesktopDictationButton', 'finishDesktopDictation'].includes(node.name.text)) {
                declarations.set(node.name.text, `const ${node.getText(ast)};`);
            }
        }
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'MemoDesktopDictationButton'
            && node.getText(ast).includes('interactionMode="mobile"') === (mode === 'mobile')) {
            buttonJsx = node.getText(ast);
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(declarations.size).toBe(2);
    expect(buttonJsx).not.toBe('');
    const update = vi.fn();
    const scope = {
        React, useEvent, DesktopDictationButton, update,
        textareaRef: inputRef, setDesktopRecording: recordingChange,
        setDesktopDictationActive: vi.fn(),
        footerIconButtonClass: '', iconSizeClass: '', beginDesktopDictation: start, cancelDesktopDictation: cancel,
        resolvedDraftBusy: false, dictationHint: null, currentSessionId: 'session', newSessionDraftOpen: false,
        setMobileDictationActive: vi.fn(),
    };
    const compiled = ts.transpileModule(`
        ${declarations.get('MemoDesktopDictationButton')}
        const Surface = ({ revision, primaryDraftKeyID }) => {
            const updateDesktopDictation = useEvent((text, final) => update(revision, text, final));
            ${declarations.get('finishDesktopDictation')}
            return (${buttonJsx});
        };
    `, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const Surface = new Function(...Object.keys(scope), `${compiled}\nreturn Surface;`)(...Object.values(scope));
    await act(async () => root.render(<Surface revision={0} primaryDraftKeyID="draft-a" />));
    mock.hookWork.mockClear();
    for (let revision = 1; revision <= 50; revision++) {
        await act(async () => root.render(<Surface revision={revision} primaryDraftKeyID="draft-a" />));
    }
    expect(mock.hookWork).not.toHaveBeenCalled();
    mock.onTranscript('最终识别');
    expect(update).toHaveBeenLastCalledWith(50, '最终识别', true);
    mock.onPartial('临时识别');
    expect(update).toHaveBeenLastCalledWith(50, '临时识别', undefined);
    await act(async () => root.render(<Surface revision={51} primaryDraftKeyID="draft-b" />));
    expect(mock.hookWork).toHaveBeenCalledTimes(1);
    mock.onTranscript('新草稿');
    expect(update).toHaveBeenLastCalledWith(51, '新草稿', true);
});

it('starts after 500ms without modifiers and confirms on release outside the input', async () => {
    vi.useFakeTimers();
    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', pointerId: 3, button: 0 });
    await act(async () => { inputRef.current!.dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(false);
    await act(async () => { vi.advanceTimersByTime(499); });
    expect(start).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(start).toHaveBeenCalledTimes(1);
    mock.dictation.status = 'recording'; await render();
    expect(recordingChange).toHaveBeenLastCalledWith(true);
    expect(host.textContent).toContain('chat.dictation.releaseConfirm');
    expect(host.textContent).not.toContain('chat.dictation.keyboardHint');
    expect(document.body.querySelector('style')?.textContent).toContain('user-select: none !important');
    expect(document.body.querySelector('style')?.textContent).toContain('cursor: none');
    expect(document.querySelector('[data-listening-cursor]')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }));
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: 1000 }));
    expect((document.querySelector('[data-listening-cursor]') as HTMLElement).style.transform).toBe('translate(1000px, 0px)');
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 4 }));
    expect(mock.dictation.confirmDictation).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, button: 0 })); });
    expect(mock.dictation.confirmDictation).toHaveBeenCalledTimes(1);
    mock.dictation.status = 'uploading'; await render();
    expect(document.querySelector('[data-listening-cursor]')).toBeNull();
    expect([...document.body.querySelectorAll('style')].some((style) => style.textContent?.includes('user-select: none !important'))).toBe(false);
});

it('finishes even when released while microphone startup is pending', async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    mock.dictation.startDictation.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    await act(async () => { inputRef.current!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', pointerId: 1, button: 0, metaKey: true })); });
    await act(async () => { vi.advanceTimersByTime(1000); });
    await act(async () => { window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, button: 0 })); });
    expect(mock.dictation.confirmDictation).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
});

it('shows loading without recording copy until microphone and stream initialization complete', async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    mock.dictation.startDictation.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    await act(async () => inputRef.current!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', pointerId: 8, button: 0 })));
    await act(async () => { vi.advanceTimersByTime(1000); });
    mock.dictation.status = 'recording'; await render();
    expect(document.querySelector('[data-listening-cursor]')).not.toBeNull();
    expect(document.querySelector('[data-listening-cursor] [data-dictation-loading]')).not.toBeNull();
    expect(button().querySelector('[data-dictation-loading]')).not.toBeNull();
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(host.textContent).not.toContain('chat.dictation.releaseConfirm');
    expect(recordingChange).toHaveBeenLastCalledWith(false);
    await act(async () => resolve());
    expect(document.querySelector('[data-dictation-loading]')).toBeNull();
    expect(document.querySelector('[data-listening-cursor]')).not.toBeNull();
    expect(button().getAttribute('aria-busy')).toBe('false');
    expect(recordingChange).toHaveBeenLastCalledWith(true);
    expect(host.textContent).toContain('chat.dictation.releaseConfirm');
});

it('keeps loading through audio teardown and final transcript delivery', async () => {
    let resolve!: () => void;
    mock.dictation.confirmDictation.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    mock.dictation.status = 'recording'; await render();
    await act(async () => button().click());
    expect(button().querySelector('[data-dictation-loading]')).not.toBeNull();
    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(host.textContent).not.toContain('chat.dictation.keyboardHint');
    mock.dictation.status = 'uploading'; await render();
    expect(button().querySelector('[data-dictation-loading]')).not.toBeNull();
    await act(async () => button().click());
    expect(mock.dictation.confirmDictation).toHaveBeenCalledTimes(1);
    mock.dictation.status = 'idle';
    await act(async () => { mock.onTranscript('整理后的最终文字'); resolve(); });
    expect(insert).toHaveBeenLastCalledWith('整理后的最终文字');
    expect(button().querySelector('[data-dictation-loading]')).toBeNull();
    expect(button().getAttribute('aria-busy')).toBe('false');
});

it('suppresses selection only after the hold activates and restores it on release', async () => {
    vi.useFakeTimers();
    const capture = vi.fn();
    Object.defineProperty(host.querySelector('[data-dictation-control]')!, 'setPointerCapture', { value: capture });
    inputRef.current!.value = 'existing draft';
    inputRef.current!.setSelectionRange(14, 14);
    inputRef.current!.focus();
    await act(async () => inputRef.current!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', pointerId: 2, button: 0 })));
    const pendingSelection = new Event('selectstart', { bubbles: true, cancelable: true });
    inputRef.current!.dispatchEvent(pendingSelection);
    expect(pendingSelection.defaultPrevented).toBe(false);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(capture).toHaveBeenCalledWith(2);
    expect(document.activeElement).not.toBe(inputRef.current);
    const selection = new Event('selectstart', { bubbles: true, cancelable: true });
    inputRef.current!.dispatchEvent(selection);
    expect(selection.defaultPrevented).toBe(true);
    inputRef.current!.setSelectionRange(0, 8);
    document.dispatchEvent(new Event('selectionchange'));
    expect(inputRef.current!.selectionStart).toBe(inputRef.current!.selectionEnd);
    expect(inputRef.current!.value).toBe('existing draft');
    const move = new MouseEvent('mousemove', { bubbles: true, cancelable: true });
    window.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    await act(async () => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, button: 0 })));
    const restored = new Event('selectstart', { bubbles: true, cancelable: true });
    inputRef.current!.dispatchEvent(restored);
    expect(restored.defaultPrevented).toBe(false);
    inputRef.current!.setSelectionRange(0, 8);
    document.dispatchEvent(new Event('selectionchange'));
    expect(inputRef.current!.selectionStart).toBe(0);
    expect(inputRef.current!.selectionEnd).toBe(8);
});

it('preserves ordinary clicks and read-only inputs', async () => {
    vi.useFakeTimers();
    for (const options of [{}, { metaKey: true, button: 2 }, { metaKey: true, pointerType: 'touch' }]) {
        inputRef.current!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, ...options }));
    }
    inputRef.current!.readOnly = true;
    inputRef.current!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, metaKey: true }));
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(start).not.toHaveBeenCalled();
});

it.each(['release', 'drag', 'cancel', 'blur', 'typing', 'unmount'])('cancels a pending hold on %s', async (action) => {
    vi.useFakeTimers();
    await act(async () => inputRef.current!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', pointerId: 9, button: 0 })));
    await act(async () => {
        if (action === 'release') window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, button: 0 }));
        if (action === 'drag') window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, clientX: 20 }));
        if (action === 'cancel') window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 9 }));
        if (action === 'blur') window.dispatchEvent(new Event('blur'));
        if (action === 'typing') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
        if (action === 'unmount') root.render(null);
    });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(start).not.toHaveBeenCalled();
    expect(mock.dictation.confirmDictation).not.toHaveBeenCalled();
});

it('toggles recording with a theme-filled mic and inserts the final text', async () => {
    await act(async () => button().click());
    expect(mock.dictation.startDictation).toHaveBeenCalledTimes(1);
    mock.dictation.status = 'recording'; await render();
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(button().className).not.toContain('!bg-transparent');
    expect(button().querySelectorAll('.motion-safe\\:animate-pulse')).toHaveLength(2);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button().click());
    expect(mock.dictation.confirmDictation).toHaveBeenCalledTimes(1);
    mock.onTranscript('测试输入');
    expect(insert).toHaveBeenCalledWith('测试输入');
});

it('finishes when the microphone button loses focus', async () => {
    mock.dictation.status = 'recording'; await render();
    await act(async () => { button().focus(); button().blur(); });
    expect(mock.dictation.confirmDictation).toHaveBeenCalledTimes(1);
});

it('mobile streams inline across touch, scroll, blur and keyboard events until the microphone is clicked again', async () => {
    await render('mobile');
    await act(async () => button().click());
    expect(start).toHaveBeenCalledTimes(1);
    mock.dictation.status = 'recording'; await render('mobile');
    await act(async () => {
        button().focus(); button().blur();
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
        document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
        window.dispatchEvent(new Event('scroll'));
        window.dispatchEvent(new Event('blur'));
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        window.dispatchEvent(new Event('openchamber:dictation-toggle'));
    });
    mock.onPartial('持续识别');
    expect(partial).toHaveBeenLastCalledWith('持续识别');
    expect(mock.dictation.confirmDictation).not.toHaveBeenCalled();
    expect(mock.dictation.cancelDictation).not.toHaveBeenCalled();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toContain('chat.dictation.keyboardHint');
    await act(async () => button().click());
    expect(mock.dictation.confirmDictation).toHaveBeenCalledTimes(1);
    mock.onTranscript('持续识别的最终文字');
    expect(insert).toHaveBeenLastCalledWith('持续识别的最终文字');
});

it('mobile compact trigger controls the same recording owner', async () => {
    await render('mobile');
    await act(async () => window.dispatchEvent(new Event('openchamber:mobile-dictation-toggle')));
    expect(mock.dictation.startDictation).toHaveBeenCalledTimes(1);
    mock.dictation.status = 'recording'; await render('mobile');
    expect(button().getAttribute('aria-pressed')).toBe('true');
    await act(async () => window.dispatchEvent(new Event('openchamber:mobile-dictation-toggle')));
    expect(mock.dictation.confirmDictation).toHaveBeenCalledTimes(1);
});

it('confirms on Enter before the composer can submit and inserts the final text', async () => {
    mock.dictation.status = 'recording'; await render();
    const input = document.createElement('textarea'); host.append(input);
    const submit = vi.fn(); input.addEventListener('keydown', submit);
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(mock.dictation.confirmDictation).toHaveBeenCalledTimes(1);
    mock.onTranscript('确认后的文字');
    expect(insert).toHaveBeenCalledWith('确认后的文字');
    expect(cancel).not.toHaveBeenCalled();
    input.remove();
});

it('shows the keyboard hint only while recording', async () => {
    expect(host.textContent).not.toContain('chat.dictation.keyboardHint');
    mock.dictation.status = 'recording'; await render();
    expect(host.textContent).toContain('chat.dictation.keyboardHint');
    for (const status of ['uploading', 'failed', 'idle']) {
        mock.dictation.status = status; await render();
        expect(host.textContent).not.toContain('chat.dictation.keyboardHint');
    }
});

it.each([
    { shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true },
    { isComposing: true }, { keyCode: 229 },
])('leaves modified and IME Enter untouched: %j', async (options) => {
    mock.dictation.status = 'recording'; await render();
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...options });
    await act(async () => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(mock.dictation.confirmDictation).not.toHaveBeenCalled();
});

it('consumes repeated Enter and Enter during finalization without confirming again', async () => {
    mock.dictation.status = 'recording'; await render();
    const repeated = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, cancelable: true });
    await act(async () => { window.dispatchEvent(repeated); });
    expect(repeated.defaultPrevented).toBe(true);
    mock.dictation.status = 'uploading'; await render();
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    await act(async () => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(mock.dictation.confirmDictation).not.toHaveBeenCalled();
});

it('leaves idle Enter and ordinary typing untouched', async () => {
    const idleEnter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    window.dispatchEvent(idleEnter);
    expect(idleEnter.defaultPrevented).toBe(false);
    mock.dictation.status = 'recording'; await render();
    for (let i = 0; i < 50; i++) {
        const event = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    }
    expect(mock.dictation.confirmDictation).not.toHaveBeenCalled();
    expect(mock.dictation.cancelDictation).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
});

it('publishes live corrections before confirmation and stops recognition on Escape', async () => {
    await act(async () => button().click());
    expect(start).toHaveBeenCalledTimes(1);
    mock.dictation.status = 'recording'; await render();
    mock.onPartial('今天');
    mock.onPartial('今天天气很好');
    expect(partial.mock.calls).toEqual([['今天'], ['今天天气很好']]);
    expect(insert).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mock.dictation.cancelDictation).toHaveBeenCalledTimes(1);
    expect(mock.dictation.confirmDictation).not.toHaveBeenCalled();
});

it('ignores window blur before capture starts but finishes after capture starts', async () => {
    await act(async () => window.dispatchEvent(new Event('blur')));
    expect(mock.dictation.confirmDictation).not.toHaveBeenCalled();
    await act(async () => button().click());
    mock.dictation.status = 'recording'; await render();
    await act(async () => window.dispatchEvent(new Event('blur')));
    expect(mock.dictation.confirmDictation).toHaveBeenCalledTimes(1);
});

it('blocks clicks during finalization and starts a fresh recording after failure', async () => {
    mock.dictation.status = 'uploading'; await render();
    expect(button().disabled).toBe(true);
    await act(async () => button().click());
    expect(mock.dictation.startDictation).not.toHaveBeenCalled();
    Object.assign(mock.dictation, { status: 'failed', error: 'Recognition failed' }); await render();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(mock.toastError).not.toHaveBeenCalled();
    expect(button().innerHTML).toContain('text-[var(--status-error)]');
    await act(async () => button().click());
    expect(mock.dictation.retryFailedDictation).not.toHaveBeenCalled();
    expect(mock.dictation.discardFailedDictation).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(mock.dictation.startDictation).toHaveBeenCalledTimes(1);
});
