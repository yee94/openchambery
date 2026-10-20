import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopDictationButton } from './DesktopDictationButton';

const mock = vi.hoisted(() => ({
    onTranscript: (_text: string) => {},
    onPartial: (_text: string) => {},
    toastError: vi.fn(), toastDismiss: vi.fn(),
    dictation: { status: 'idle', error: null as string | null,
        startDictation: vi.fn(), confirmDictation: vi.fn(), retryFailedDictation: vi.fn(), cancelDictation: vi.fn(), discardFailedDictation: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { error: mock.toastError, dismiss: mock.toastDismiss } }));
vi.mock('@/hooks/useDictation', () => ({ useDictation: (options: { onTranscript: (text: string) => void; onPartialTranscript: (text: string) => void }) => {
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
const render = async () => { await act(async () => root.render(<DesktopDictationButton onInsert={insert} onPartial={partial} onStart={start} onCancel={cancel} />)); };
const button = () => host.querySelector('button')!;
beforeEach(async () => {
    vi.clearAllMocks();
    Object.assign(mock.dictation, { status: 'idle', error: null });
    host = document.createElement('div'); document.body.append(host);
    root = createRoot(host); await render();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

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
