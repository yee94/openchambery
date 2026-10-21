import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HoldToTalkComposer } from './HoldToTalkComposer';

const speech = vi.hoisted(() => ({
    status: 'idle', isStarting: false, partialTranscript: '', error: null as string | null, volume: 0, duration: 0,
    startDictation: vi.fn(), confirmDictation: vi.fn(), cancelDictation: vi.fn(),
    discardFailedDictation: vi.fn(), retryFailedDictation: vi.fn(), acceptPartialTranscript: vi.fn(),
}));
const transcript = vi.hoisted(() => ({ deliver: (_text: string) => {} }));
vi.mock('@/hooks/useDictation', () => ({ useDictation: (options: { onTranscript: (text: string) => void }) => { transcript.deliver = options.onTranscript; return speech; } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/lib/dictation/use-dictation-audio-source', () => ({ isDictationCaptureSupported: () => true }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let button: HTMLTextAreaElement;
const containerRef = { current: null as HTMLFormElement | null };
const onHintChange = vi.fn();
const onInsert = vi.fn();
const onSend = vi.fn();
const onRelease = vi.fn();
const onError = vi.fn();
const render = async () => {
    await act(async () => root.render(<HoldToTalkComposer containerRef={containerRef} disabled={false} onInsert={onInsert} onSend={onSend} onRelease={onRelease} onError={onError} onHintChange={onHintChange} />));
    button = containerRef.current!.querySelector('textarea')!;
    button.setPointerCapture = vi.fn();
};
beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    speech.status = 'idle'; speech.isStarting = false; speech.partialTranscript = ''; speech.error = null;
    host = document.createElement('div'); document.body.append(host);
    containerRef.current = document.createElement('form');
    containerRef.current.append(document.createElement('textarea'));
    document.body.append(containerRef.current);
    root = createRoot(host);
    await render();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); containerRef.current?.remove(); vi.useRealTimers(); });
const pointer = async (type: string, x = 200, id = 1, y = 200) => {
    await act(async () => button.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, isPrimary: true, button: 0, clientX: x, clientY: y })));
    if (type === 'pointerdown') await act(async () => vi.advanceTimersByTime(300));
};

it('opens editing on release and ignores subsequent capture loss', async () => {
    await pointer('pointerdown');
    expect(speech.startDictation).toHaveBeenCalledTimes(1);
    await pointer('pointerup');
    await pointer('lostpointercapture');
    expect(speech.confirmDictation).toHaveBeenCalledTimes(1);
    expect(speech.cancelDictation).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
    transcript.deliver('可编辑的识别文本');
    expect(onInsert).toHaveBeenCalledWith('可编辑的识别文本');
    expect(onSend).not.toHaveBeenCalled();
});

it('shows the overlay and a loading indicator while iOS opens the microphone', async () => {
    speech.isStarting = true;
    await render();
    await pointer('pointerdown');
    expect(document.querySelector('.oc-speech-overlay')).not.toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('');
    expect(document.querySelector('[data-dictation-loading]')).not.toBeNull();
    expect(document.querySelector('[data-dictation-loading] > span')?.classList.length).toBe(1);
    expect(document.querySelectorAll('[data-dictation-loading] > span > span')).toHaveLength(3);
    speech.isStarting = false;
    speech.status = 'recording';
    await render();
    expect(document.querySelector('[data-dictation-loading]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('chat.dictation.listening');
});

it('arms left cancellation, ignores another pointer and discards on release', async () => {
    await pointer('pointerdown');
    await pointer('pointermove', 100, 2);
    expect(onHintChange).toHaveBeenLastCalledWith('editing');
    await pointer('pointermove', 100);
    expect(onHintChange).toHaveBeenLastCalledWith('cancelling');
    expect(document.querySelector('.oc-speech-target--cancel')?.getAttribute('data-active')).toBe('true');
    await pointer('pointerup', 100);
    expect(speech.cancelDictation).toHaveBeenCalledTimes(1);
    expect(speech.confirmDictation).not.toHaveBeenCalled();
    expect(onHintChange).toHaveBeenLastCalledWith(null);
});

it('allows moving back to center to keep the recording', async () => {
    await pointer('pointerdown'); await pointer('pointermove', 100); await pointer('pointermove', 180);
    await pointer('pointerup', 180);
    expect(speech.confirmDictation).toHaveBeenCalledTimes(1);
});

it('upper-right slide sends only on release', async () => {
    await pointer('pointerdown'); await pointer('pointermove', 290, 1, 100);
    expect(onHintChange).toHaveBeenLastCalledWith('recording');
    expect(document.querySelector('.oc-speech-target--send')?.getAttribute('data-active')).toBe('true');
    expect(document.querySelector('.oc-speech-target--send')?.textContent).toContain('chat.dictation.send');
    expect(speech.confirmDictation).not.toHaveBeenCalled();
    await pointer('pointerup', 290);
    expect(speech.confirmDictation).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(button);
    transcript.deliver('直接发送');
    expect(onSend).toHaveBeenCalledExactlyOnceWith('直接发送');
    expect(onInsert).not.toHaveBeenCalled();
});

it('activates the half under the finger when entering the bottom targets', async () => {
    await pointer('pointerdown');
    const targets = document.querySelector('.oc-speech-targets')!;
    vi.spyOn(targets, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 80));
    await pointer('pointermove', 230, 1, 140);
    expect(onHintChange).toHaveBeenLastCalledWith('recording');
    await pointer('pointermove', 170, 1, 140);
    expect(onHintChange).toHaveBeenLastCalledWith('cancelling');
    await pointer('pointermove', 200, 1, 200);
    expect(onHintChange).toHaveBeenLastCalledWith('editing');
    await pointer('pointerup');
    expect(speech.confirmDictation).toHaveBeenCalledTimes(1);
});

it('moving vertically does not cancel and returning from send restores editing', async () => {
    await pointer('pointerdown'); await pointer('pointermove', 200, 1, 80);
    expect(onHintChange).toHaveBeenLastCalledWith('editing');
    await pointer('pointermove', 290); await pointer('pointermove', 200);
    await pointer('pointerup'); transcript.deliver('编辑');
    expect(onInsert).toHaveBeenCalledWith('编辑');
    expect(onSend).not.toHaveBeenCalled();
    expect(speech.cancelDictation).not.toHaveBeenCalled();
});

it('cancels interrupted gestures without sending', async () => {
    await pointer('pointerdown'); await pointer('pointercancel'); await pointer('pointerup');
    expect(speech.cancelDictation).toHaveBeenCalledTimes(1);
    expect(speech.confirmDictation).not.toHaveBeenCalled();
});

it('replaces live captions before release without sending', async () => {
    await pointer('pointerdown'); speech.status = 'recording';
    speech.partialTranscript = '今天'; await render();
    speech.partialTranscript = '今天天气很好'; await render();
    expect(document.querySelector('.oc-speech-interim')?.textContent).toBe('今天天气很好');
    expect(speech.confirmDictation).not.toHaveBeenCalled();
});

it('leaves the original composer intact and a short tap focuses typing without recording', async () => {
    expect(document.querySelector('.oc-speech-overlay')).toBeNull();
    await act(async () => button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true, button: 0, clientY: 200 })));
    await pointer('pointerup');
    expect(document.activeElement).toBe(button);
    await act(async () => vi.advanceTimersByTime(500));
    expect(speech.startDictation).not.toHaveBeenCalled();
    expect(containerRef.current?.children).toHaveLength(1);
});

it('cancels on window blur', async () => {
    await pointer('pointerdown');
    await act(async () => window.dispatchEvent(new Event('blur')));
    await pointer('pointerup');
    expect(speech.cancelDictation).toHaveBeenCalledTimes(1);
    expect(speech.confirmDictation).not.toHaveBeenCalled();
});

it('starts a hold on the empty textarea after a short tap has focused it', async () => {
    await act(async () => button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: 200, clientY: 200 })));
    await pointer('pointerup');
    expect(document.activeElement).toBe(button);
    await pointer('pointerdown');
    expect(speech.startDictation).toHaveBeenCalledTimes(1);
    await pointer('pointercancel');
    await pointer('pointerdown');
    expect(speech.startDictation).toHaveBeenCalledTimes(2);
});

it('keeps native selection for existing text and suppresses empty-input selection even after release', async () => {
    button.value = '正在编辑的草稿';
    button.focus();
    const editingDown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 });
    await act(async () => button.dispatchEvent(editingDown));
    await act(async () => vi.advanceTimersByTime(500));
    expect(editingDown.defaultPrevented).toBe(false);
    expect(speech.startDictation).not.toHaveBeenCalled();
    const editingSelection = new Event('selectstart', { bubbles: true, cancelable: true });
    button.dispatchEvent(editingSelection);
    expect(editingSelection.defaultPrevented).toBe(false);

    button.value = '';
    await pointer('pointerdown');
    for (const type of ['selectstart', 'contextmenu']) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        button.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    }
    await pointer('pointercancel');
    const afterCancel = new Event('selectstart', { bubbles: true, cancelable: true });
    button.dispatchEvent(afterCancel);
    expect(afterCancel.defaultPrevented).toBe(true);
    button.value = '恢复编辑';
    const afterTyping = new Event('selectstart', { bubbles: true, cancelable: true });
    button.dispatchEvent(afterTyping);
    expect(afterTyping.defaultPrevented).toBe(false);
});

it('does not start capture when typing or paste fills the input during the hold delay', async () => {
    await act(async () => button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 })));
    button.value = '粘贴的草稿';
    await act(async () => vi.advanceTimersByTime(300));
    await pointer('pointerup');
    expect(speech.startDictation).not.toHaveBeenCalled();
    expect(speech.confirmDictation).not.toHaveBeenCalled();
    expect(button.value).toBe('粘贴的草稿');
});

it('blocks selection of compact placeholder text but leaves toolbar controls alone', async () => {
    const compact = document.createElement('div');
    compact.setAttribute('data-oc-composer-compact-surface', 'true');
    const placeholder = document.createElement('span');
    placeholder.textContent = '输入消息，按住转文字';
    const attach = document.createElement('button');
    compact.append(placeholder, attach);
    containerRef.current!.append(compact);
    for (const type of ['selectstart', 'contextmenu']) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        placeholder.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        const toolbarEvent = new Event(type, { bubbles: true, cancelable: true });
        attach.dispatchEvent(toolbarEvent);
        expect(toolbarEvent.defaultPrevented).toBe(false);
    }
});

it('keeps recording after capture loss and follows move/release outside the textarea', async () => {
    await pointer('pointerdown');
    await pointer('lostpointercapture');
    expect(speech.cancelDictation).not.toHaveBeenCalled();
    await act(async () => document.body.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 290, clientY: 100 })));
    expect(onHintChange).toHaveBeenLastCalledWith('recording');
    await act(async () => document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 290, clientY: 100 })));
    expect(speech.confirmDictation).toHaveBeenCalledTimes(1);
    transcript.deliver('移出后发送');
    expect(onSend).toHaveBeenCalledWith('移出后发送');
    expect(onInsert).not.toHaveBeenCalled();
});

it('tracks cancellation over another element even when it stops bubbling events', async () => {
    const outside = document.createElement('div');
    document.body.append(outside);
    outside.addEventListener('pointermove', (event) => event.stopPropagation());
    outside.addEventListener('pointerup', (event) => event.stopPropagation());
    try {
        await pointer('pointerdown');
        await act(async () => outside.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 2, clientX: 100, clientY: 80 })));
        expect(onHintChange).toHaveBeenLastCalledWith('editing');
        await act(async () => outside.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 100, clientY: 80 })));
        expect(onHintChange).toHaveBeenLastCalledWith('cancelling');
        await act(async () => outside.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 100, clientY: 80 })));
        expect(speech.cancelDictation).toHaveBeenCalledTimes(1);
        expect(speech.confirmDictation).not.toHaveBeenCalled();
    } finally { outside.remove(); }
});

it('honors a real system pointer cancellation outside the original input', async () => {
    await pointer('pointerdown');
    await act(async () => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })));
    await act(async () => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 })));
    expect(speech.cancelDictation).toHaveBeenCalledTimes(1);
    expect(speech.confirmDictation).not.toHaveBeenCalled();
});

it('removing disabled voice controls clears a pending hold and restores native input events', async () => {
    await act(async () => button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 })));
    await act(async () => root.render(null));
    await act(async () => vi.advanceTimersByTime(500));
    expect(speech.startDictation).not.toHaveBeenCalled();
    for (const type of ['selectstart', 'contextmenu']) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        button.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    }
    await pointer('pointerdown');
    expect(speech.startDictation).not.toHaveBeenCalled();
});

it('prevents native touch selection on an empty input and blurs it only once a hold starts', async () => {
    button.focus();
    const touch = new Event('touchstart', { bubbles: true, cancelable: true });
    button.dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button);
    await pointer('pointerdown');
    expect(document.activeElement).not.toBe(button);
    await pointer('pointercancel');
    button.value = 'editable draft';
    const editingTouch = new Event('touchstart', { bubbles: true, cancelable: true });
    button.dispatchEvent(editingTouch);
    expect(editingTouch.defaultPrevented).toBe(false);
});

it.each(['idle', 'recording', 'failed'])('dismisses a %s error on release without confirming', async (status) => {
    const dismiss = () => { speech.error = null; speech.status = 'idle'; };
    speech.cancelDictation.mockImplementation(dismiss);
    speech.discardFailedDictation.mockImplementation(dismiss);
    await pointer('pointerdown');
    speech.status = status;
    speech.error = 'ASR unavailable';
    await render();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('ASR unavailable');
    expect(document.querySelector('[role="status"]')).toBeNull();
    await pointer('pointerup');
    expect(speech.confirmDictation).not.toHaveBeenCalled();
    if (status === 'recording') expect(speech.cancelDictation).toHaveBeenCalledTimes(1);
    else expect(speech.discardFailedDictation).toHaveBeenCalledTimes(1);
    await render();
    expect(document.querySelector('.oc-speech-overlay')).toBeNull();
});

it('does not reopen the overlay for an error arriving after release', async () => {
    speech.error = 'Microphone unavailable';
    await render();
    expect(document.querySelector('.oc-speech-overlay')).toBeNull();
});

it.each(['send', 'edit'])('shows loading on %s release until finalization completes', async (intent) => {
    let finish!: () => void;
    speech.confirmDictation.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await pointer('pointerdown');
    speech.status = 'recording';
    speech.partialTranscript = '待整理的文字';
    await render();
    if (intent === 'send') await pointer('pointermove', 290);
    await pointer('pointerup');
    expect(document.querySelector('.oc-speech-overlay [data-dictation-loading]')).not.toBeNull();
    expect(document.querySelector('.oc-speech-gesture-stage')).toBeNull();
    expect(onRelease).toHaveBeenCalledExactlyOnceWith('待整理的文字');
    expect(onHintChange).toHaveBeenLastCalledWith('processing');
    speech.status = 'uploading';
    await render();
    expect(document.querySelector('.oc-speech-overlay [data-dictation-loading]')).not.toBeNull();
    await act(async () => window.dispatchEvent(new Event('blur')));
    expect(speech.cancelDictation).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('chat.dictation.cancel');
    await act(async () => finish());
    expect(document.querySelector('.oc-speech-overlay')).toBeNull();
    expect(onHintChange).toHaveBeenLastCalledWith(null);
});
