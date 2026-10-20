import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useDictation, type UseDictationResult } from './useDictation';

const mock = vi.hoisted(() => ({
    provider: 'local',
    getStartOptions: () => ({} as { provider?: string }),
    audio: { start: vi.fn(), stop: vi.fn(), volume: 0 },
    sender: { clearAll: vi.fn(), cancel: vi.fn(), restartStream: vi.fn(), getDictationId: vi.fn(),
        getFinalSeq: vi.fn(), finish: vi.fn(), hasSegments: vi.fn(), resetStreamForReplay: vi.fn(), enqueueSegment: vi.fn() },
}));
vi.mock('@/lib/dictation/use-dictation-audio-source', () => ({ useDictationAudioSource: () => mock.audio }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/dictation/dictation-client', () => ({ dictationClient: {
    onPartial: () => () => {}, subscribeConnectionStatus: () => () => {},
} }));
vi.mock('@/lib/dictation/dictation-stream-sender', () => ({ DictationStreamSender: class {
    constructor(options: { getStartOptions: () => { provider?: string } }) {
        mock.getStartOptions = options.getStartOptions;
        return mock.sender;
    }
} }));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: { getState: () => ({ sttProvider: mock.provider }) } }));
let current: UseDictationResult;
let root: ReturnType<typeof createRoot>;
const onTranscript = vi.fn();
const onError = vi.fn();
function Probe() { current = useDictation({ onTranscript, onError }); return null; }
beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.resetAllMocks();
    mock.provider = 'local';
    mock.audio.start.mockResolvedValue(undefined); mock.audio.stop.mockResolvedValue(undefined);
    mock.sender.getFinalSeq.mockReturnValue(0); mock.sender.hasSegments.mockReturnValue(true);
    mock.sender.restartStream.mockResolvedValue(undefined);
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
});
afterEach(async () => { await act(async () => root.unmount()); });

it('starts Volcengine with Host-owned settings and no local key or resource override', async () => {
    mock.provider = 'volcengine';
    await act(async () => current.startDictation());
    expect(mock.sender.restartStream).toHaveBeenCalledOnce();
    expect(mock.getStartOptions()).toEqual({ provider: 'volcengine' });
});

it('explains a missing microphone in both visible state and error notifications', async () => {
    mock.audio.start.mockRejectedValue(new DOMException('Requested device not found', 'NotFoundError'));
    await act(async () => current.startDictation());
    expect(current.error).toBe('chat.dictation.error.microphoneNotFound');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'chat.dictation.error.microphoneNotFound' }));
    expect(mock.sender.restartStream).not.toHaveBeenCalled();
});

it('does not open a stream when microphone permission arrives after cancellation', async () => {
    let grant!: () => void;
    mock.audio.start.mockReturnValue(new Promise<void>((resolve) => { grant = resolve; }));
    let start!: Promise<void>;
    await act(async () => { start = current.startDictation(); });
    await act(async () => current.cancelDictation());
    await act(async () => { grant(); await start; });
    expect(current.status).toBe('idle');
    expect(mock.sender.restartStream).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
});

it('discards final responses arriving after cancellation', async () => {
    let finish!: (value: { text: string }) => void;
    mock.sender.finish.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await act(async () => current.startDictation());
    let confirmation!: Promise<string | null>;
    await act(async () => { confirmation = current.confirmDictation(); });
    await act(async () => current.cancelDictation());
    await act(async () => { finish({ text: 'late words' }); await confirmation; });
    expect(current.status).toBe('idle');
    expect(onTranscript).not.toHaveBeenCalled();
});

it('discards a final response when the composer unmounts for another draft', async () => {
    let finish!: (value: { text: string }) => void;
    mock.sender.finish.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await act(async () => current.startDictation());
    let confirmation!: Promise<string | null>;
    await act(async () => { confirmation = current.confirmDictation(); });
    await act(async () => root.render(null));
    await act(async () => { finish({ text: 'wrong draft' }); await confirmation; });
    expect(onTranscript).not.toHaveBeenCalled();
});

it('returns the final corrected transcript once after normal release', async () => {
    mock.sender.finish.mockResolvedValue({ text: '最终字幕' });
    await act(async () => current.startDictation());
    await act(async () => current.confirmDictation());
    expect(current.status).toBe('idle');
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith('最终字幕');
});

it('clears a failed recording and opens a new microphone capture in the same action', async () => {
    mock.sender.finish.mockRejectedValueOnce(new Error('Volcengine ASR returned no final transcript'));
    await act(async () => current.startDictation());
    await act(async () => current.confirmDictation());
    expect(current.status).toBe('failed');
    await act(async () => {
        current.discardFailedDictation();
        await current.startDictation();
    });
    expect(current.status).toBe('recording');
    expect(current.error).toBeNull();
    expect(mock.audio.start).toHaveBeenCalledTimes(2);
    expect(mock.sender.finish).toHaveBeenCalledTimes(1);
    mock.sender.finish.mockResolvedValueOnce({ text: '新的录音' });
    await act(async () => current.confirmDictation());
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith('新的录音');
});
