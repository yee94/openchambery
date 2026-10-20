import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useEvent, useEventListener, useLocalStorage } from '@reactuses/core';
import { toast } from 'sonner';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { useSessionMessages, useSessionMessagesResolved } from '@/sync/sync-context';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { acquireScreenAwake } from '@/lib/voice/screen-awake';
import { useI18n } from '@/lib/i18n';
import { AutoReadContext, AutoReadPlaybackContext, type RenderedReply } from './auto-read-context';

export function MobileAutoReadProvider({ sessionId, directory, active, children }: {
    sessionId: string; directory?: string; active: boolean; children: ReactNode;
}) {
    const { t } = useI18n();
    const messages = useSessionMessages(sessionId, directory);
    const resolved = useSessionMessagesResolved(sessionId, directory);
    const [preference, setPreference] = useLocalStorage('openchamber.auto-read', false);
    const preferred = preference === true;
    const [runtimeEpoch, setRuntimeEpoch] = useState(0);
    const [enabled, setEnabled] = useState(false);
    const [playingReply, setPlayingReply] = useState<RenderedReply | null>(null);
    const [visible, setVisible] = useState(document.visibilityState === 'visible');
    const speech = useMessageTTS({ enabled });
    const state = useRef({ enabled: false, generation: 0, floor: 0, seen: new Set<string>(), observed: new Set<string>(), pending: [] as RenderedReply[], playing: false });
    const audioUnlocked = useRef(false);
    const available = active && Boolean(sessionId) && resolved;
    const stop = useEvent(() => {
        const current = state.current;
        current.enabled = false;
        current.generation += 1;
        current.pending = [];
        current.playing = false;
        current.seen.clear();
        current.observed.clear();
        audioUnlocked.current = false;
        speech.stop();
        setPlayingReply(null);
        setEnabled(false);
    });
    const drain = useEvent(() => {
        const current = state.current;
        if (!current.enabled || current.playing || !active || document.visibilityState !== 'visible') return;
        const next = current.pending.shift();
        if (!next) return;
        current.playing = true;
        setPlayingReply(next);
        const generation = current.generation;
        void speech.play(next.text, (error) => {
            if (generation !== current.generation) return;
            current.playing = false;
            setPlayingReply(null);
            if (error) { stop(); toast.error(t('mobile.menu.autoReadFailed')); return; }
            drain();
        });
    });
    const rendered = useEvent((reply: RenderedReply) => {
        const current = state.current;
        if (!current.enabled || !available || reply.sessionId !== sessionId || !reply.text.trim()
            || (reply.created < current.floor && !current.observed.has(reply.messageId)) || current.seen.has(reply.messageId)) return;
        current.seen.add(reply.messageId);
        current.pending.push(reply);
        drain();
    });
    const streaming = useEvent((sourceSessionId: string, messageId: string) => {
        if (state.current.enabled && available && sourceSessionId === sessionId) state.current.observed.add(messageId);
    });
    const toggle = useEvent(() => {
        if (preferred) { setPreference(false); stop(); return; }
        if (!available) return;
        setPreference(true);
        void speech.unlock().catch(() => {
            toast.error(t('mobile.menu.autoReadFailed'));
        });
    });
    const start = useEvent(() => {
        const current = state.current;
        current.floor = Math.max(0, ...messages.map((message) => message.time.created));
        current.seen = new Set(messages.filter((message) => message.time.completed != null || message.role !== 'assistant').map((message) => message.id));
        current.enabled = true;
        setEnabled(true);
    });
    useEffect(() => {
        stop();
        if (preferred && available) start();
        return stop;
    }, [sessionId, directory, preferred, available, runtimeEpoch, start, stop]);
    useEffect(() => subscribeRuntimeEndpointChanged(() => {
        stop();
        setRuntimeEpoch((epoch) => epoch + 1);
    }), [stop]);
    const disable = useEvent(() => { setPreference(false); stop(); });
    useEventListener('pointerdown', () => {
        if (!state.current.enabled || audioUnlocked.current) return;
        audioUnlocked.current = true;
        const generation = state.current.generation;
        void speech.unlock().catch(() => {
            if (generation === state.current.generation) audioUnlocked.current = false;
        });
    }, document);
    useEventListener('visibilitychange', () => {
        setVisible(document.visibilityState === 'visible');
        if (document.visibilityState === 'visible') drain();
        else {
            state.current.generation += 1;
            state.current.playing = false;
            state.current.pending = [];
            speech.stop();
            setPlayingReply(null);
        }
    }, document);
    useEffect(() => {
        if (!enabled || !active || !visible) return;
        let disposed = false;
        let release: (() => Promise<void>) | undefined;
        void acquireScreenAwake().then((cleanup) => {
            if (disposed) void cleanup().catch(() => undefined);
            else release = cleanup;
        }).catch(() => {
            if (!disposed) toast.warning(t('mobile.menu.autoReadAwakeFailed'));
        });
        return () => { disposed = true; void release?.().catch(() => undefined); };
    }, [enabled, active, visible, sessionId, directory, runtimeEpoch, t]);
    const context = useMemo(() => ({ enabled: preferred, available, toggle, rendered, streaming }), [preferred, available, toggle, rendered, streaming]);
    const playback = useMemo(() => enabled && active && visible && speech.isPlaying && playingReply?.sessionId === sessionId
        ? { sessionId, messageId: playingReply.messageId, stop: disable } : null,
    [enabled, active, visible, speech.isPlaying, playingReply, sessionId, disable]);
    return <AutoReadContext.Provider value={context}><AutoReadPlaybackContext.Provider value={playback}>{children}</AutoReadPlaybackContext.Provider></AutoReadContext.Provider>;
}

export function MobileAutoReadMenuItem({ children }: {
    children: (state: { enabled: boolean; available: boolean; toggle: () => void }) => ReactNode;
}) {
    const context = useContext(AutoReadContext);
    if (!context) return null;
    return children(context);
}
