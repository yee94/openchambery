import React, { act, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MobileAutoReadProvider, MobileAutoReadMenuItem } from './MobileAutoRead';
import { AutoReadContext, AutoReadPlaybackContext, useAutoReadRenderedReply } from './auto-read-context';

const mocks = vi.hoisted(() => ({
    messages: [{ id: 'old', role: 'assistant', time: { created: 10, completed: 20 } }],
    resolved: true, play: vi.fn(), stop: vi.fn(), unlock: vi.fn(), acquire: vi.fn(), release: vi.fn(),
    runtimeChanged: () => {},
}));
vi.mock('@/sync/sync-context', () => ({ useSessionMessages: () => mocks.messages, useSessionMessagesResolved: () => mocks.resolved }));
vi.mock('@/hooks/useMessageTTS', () => ({ useMessageTTS: () => ({ isPlaying: true, play: mocks.play, stop: mocks.stop, unlock: mocks.unlock }) }));
vi.mock('@/lib/voice/screen-awake', () => ({ acquireScreenAwake: mocks.acquire }));
vi.mock('@/lib/runtime-switch', () => ({ subscribeRuntimeEndpointChanged: (callback: () => void) => { mocks.runtimeChanged = callback; return () => {}; } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: translate }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
const translate = (key: string) => key;
let context: React.ContextType<typeof AutoReadContext>;
let playback: React.ContextType<typeof AutoReadPlaybackContext>;
function Probe({ id, created, completed = true, sessionId }: { id: string; created: number; completed?: boolean; sessionId: string }) {
    context = useContext(AutoReadContext);
    playback = useContext(AutoReadPlaybackContext);
    useAutoReadRenderedReply({ sessionId, messageId: id, created, completed, text: `reply ${id}` });
    return null;
}
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
async function render(id = 'old', created = 10, completed = true, sessionId = 's1', active = true) {
    await act(async () => root.render(<MobileAutoReadProvider sessionId={sessionId} directory="/project" active={active}>
        <MobileAutoReadMenuItem>{({ enabled, available, toggle }) => (
            <button role="menuitemcheckbox" aria-checked={enabled} disabled={!available} onClick={toggle} />
        )}</MobileAutoReadMenuItem>
        <Probe id={id} created={created} completed={completed} sessionId={sessionId} />
    </MobileAutoReadProvider>));
    await act(async () => vi.advanceTimersByTime(40));
}
beforeEach(async () => {
    vi.useFakeTimers(); vi.clearAllMocks();
    localStorage.removeItem('yuri.auto-read');
    mocks.messages = [{ id: 'old', role: 'assistant', time: { created: 10, completed: 20 } }];
    mocks.resolved = true;
    mocks.play.mockResolvedValue(undefined); mocks.unlock.mockResolvedValue(undefined);
    mocks.release.mockResolvedValue(undefined); mocks.acquire.mockResolvedValue(mocks.release);
    host = document.createElement('div'); root = createRoot(host);
    await render();
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
const enable = async () => { await act(async () => context!.toggle()); await act(async () => vi.advanceTimersByTime(40)); };

it('does not read existing history or streaming text, then reads a settled reply only once', async () => {
    await enable();
    expect(mocks.play).not.toHaveBeenCalled();
    expect(host.querySelector('[role="menuitemcheckbox"]')?.getAttribute('aria-checked')).toBe('true');
    await render('new', 30, false); expect(mocks.play).not.toHaveBeenCalled();
    await render('new', 30); expect(mocks.play).toHaveBeenCalledTimes(1);
    await render('new', 30); expect(mocks.play).toHaveBeenCalledTimes(1);
    await render('older-page', 5); expect(mocks.play).toHaveBeenCalledTimes(1);
});

it('queues replies until actual audio completion instead of overlapping synthesis', async () => {
    await enable(); await render('one', 30); await render('two', 40);
    expect(mocks.play).toHaveBeenCalledTimes(1);
    expect(playback?.messageId).toBe('one');
    await act(async () => mocks.play.mock.calls[0][1]());
    expect(mocks.play).toHaveBeenCalledTimes(2);
    expect(mocks.play.mock.calls[1][0]).toBe('reply two');
    expect(playback?.messageId).toBe('two');
    await act(async () => mocks.play.mock.calls[1][1]());
    expect(playback).toBeNull();
});

it('stops automatic speech from the active message control', async () => {
    await enable(); await render('one', 30);
    expect(playback?.sessionId).toBe('s1');
    await act(async () => playback!.stop());
    expect(playback).toBeNull();
    expect(context!.enabled).toBe(false);
    expect(mocks.stop).toHaveBeenCalled();
});

it('releases screen lock and stops playback on disable; late completion cannot drain queue', async () => {
    await enable(); await render('one', 30); await render('two', 40);
    const finish = mocks.play.mock.calls[0][1];
    await act(async () => context!.toggle());
    await act(async () => finish());
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.play).toHaveBeenCalledTimes(1);
    expect(context!.enabled).toBe(false);
    expect(playback).toBeNull();
});

it.each(['session', 'leave', 'runtime'])('stops on %s scope changes', async (change) => {
    await enable(); await render('one', 30);
    if (change === 'runtime') await act(async () => mocks.runtimeChanged());
    else await render('one', 30, true, change === 'session' ? 's2' : 's1', change !== 'leave');
    expect(context!.enabled).toBe(true);
    expect(localStorage.getItem('yuri.auto-read')).toBe('true');
    expect(mocks.release).toHaveBeenCalledTimes(1);
});

it('retains the preference across sessions but does not replay their history', async () => {
    await enable(); await render('one', 30);
    const oldFinish = mocks.play.mock.calls[0][1];
    mocks.messages = [{ id: 'history-s2', role: 'assistant', time: { created: 100, completed: 110 } }];
    await render('history-s2', 100, true, 's2');
    expect(context!.enabled).toBe(true);
    expect(mocks.play).toHaveBeenCalledTimes(1);
    await act(async () => oldFinish());
    await render('new-s2', 120, true, 's2');
    expect(mocks.play).toHaveBeenCalledTimes(2);
    expect(mocks.play.mock.calls[1][0]).toBe('reply new-s2');
});

it('restores localStorage on remount, waits for hydration, and persists an explicit disable', async () => {
    await enable();
    await act(async () => root.unmount());
    root = createRoot(host);
    mocks.resolved = false;
    await render();
    expect(context!.enabled).toBe(true);
    expect(mocks.play).not.toHaveBeenCalled();
    mocks.resolved = true;
    await render();
    expect(mocks.play).not.toHaveBeenCalled();
    await render('after-reload', 30);
    expect(mocks.play).toHaveBeenCalledTimes(1);
    await act(async () => context!.toggle());
    expect(localStorage.getItem('yuri.auto-read')).toBe('false');
    await act(async () => root.unmount());
    root = createRoot(host);
    await render('another', 40);
    expect(context!.enabled).toBe(false);
    expect(mocks.play).toHaveBeenCalledTimes(1);
});

it('releases a late wake-lock acquisition after disabling', async () => {
    let resolve!: (release: () => Promise<void>) => void;
    mocks.acquire.mockReturnValue(new Promise((done) => { resolve = done; }));
    await enable(); await act(async () => context!.toggle());
    await act(async () => resolve(mocks.release));
    expect(mocks.release).toHaveBeenCalledTimes(1);
});

it('does not enable before transcript hydration', async () => {
    mocks.resolved = false; await render(); await enable();
    expect(context!.enabled).toBe(false); expect(mocks.acquire).not.toHaveBeenCalled();
});
