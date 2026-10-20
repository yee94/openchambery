import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DictationTestDialog } from './DictationTestDialog';

const mock = vi.hoisted(() => ({
    supported: true, onTranscript: (_text: string) => {},
    dictation: { status: 'idle', partialTranscript: '', volume: 0, duration: 0, error: null as string | null,
        startDictation: vi.fn(), confirmDictation: vi.fn(), cancelDictation: vi.fn(),
        discardFailedDictation: vi.fn(), retryFailedDictation: vi.fn() },
}));
vi.mock('@/hooks/useDictation', () => ({ useDictation: (options: { onTranscript: (text: string) => void }) => {
    mock.onTranscript = options.onTranscript; return mock.dictation;
} }));
vi.mock('@/lib/dictation/use-dictation-audio-source', () => ({ isDictationCaptureSupported: () => mock.supported }));
vi.mock('@/lib/runtime-switch', () => ({ subscribeRuntimeEndpointChanged: () => () => {} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const close = vi.fn();
const render = async () => { await act(async () => root.render(<DictationTestDialog onClose={close} />)); };
const click = async (text: string) => {
    const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.includes(text));
    expect(button).toBeDefined();
    await act(async () => button!.click());
};
beforeEach(async () => {
    vi.clearAllMocks(); mock.supported = true;
    Object.assign(mock.dictation, { status: 'idle', partialTranscript: '', volume: 0, duration: 0, error: null });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await render();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('starts capture and displays live and final recognition inside the tester', async () => {
    await click('startRecording'); expect(mock.dictation.startDictation).toHaveBeenCalledTimes(1);
    Object.assign(mock.dictation, { status: 'recording', partialTranscript: '正在测试', volume: 0.5, duration: 3 });
    await render();
    expect(document.querySelector('[role="log"]')?.textContent).toBe('正在测试');
    expect(document.querySelector('progress')).toBeNull();
    await click('finishRecording'); expect(mock.dictation.confirmDictation).toHaveBeenCalledTimes(1);
    Object.assign(mock.dictation, { status: 'idle', partialTranscript: '' });
    await act(async () => mock.onTranscript('正在测试麦克风。')); await render();
    expect(document.querySelector('[role="log"]')?.textContent).toBe('正在测试麦克风。');
    expect(close).not.toHaveBeenCalled();
});

it('cancels recording before closing', async () => {
    mock.dictation.status = 'recording'; await render();
    await act(async () => (document.querySelector('[data-slot="dialog-close"]') as HTMLButtonElement).click());
    expect(mock.dictation.cancelDictation).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
});

it('disables capture in unsupported environments', async () => {
    mock.supported = false; await render(); await click('startRecording');
    expect(mock.dictation.startDictation).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('recordingUnsupported');
});

it('shows failure and offers replay', async () => {
    Object.assign(mock.dictation, { status: 'failed', error: 'Permission denied' }); await render();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Permission denied');
    await click('chat.dictation.retry'); expect(mock.dictation.retryFailedDictation).toHaveBeenCalledTimes(1);
});
