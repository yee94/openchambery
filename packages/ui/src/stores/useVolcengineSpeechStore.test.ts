import { beforeEach, describe, expect, it } from 'vitest';
import { useVolcengineSpeechStore } from './useVolcengineSpeechStore';
import { parseSettingsBootstrap } from '@/queries/settingsBootstrapParser';

beforeEach(() => {
    localStorage.removeItem('volcengine-speech');
    useVolcengineSpeechStore.setState({ apiKey: '', voice: 'zh_female_vv_uranus_bigtts', resourceId: 'seed-tts-2.0' });
});

describe('Volcengine settings contract', () => {
    it('automatically saves the key and restores it with voice preferences after reload', async () => {
        const state = useVolcengineSpeechStore.getState();
        state.setApiKey('credential-sentinel');
        state.setVoice('custom_speaker');
        state.setResourceId('seed-icl-2.0');
        const saved = localStorage.getItem('volcengine-speech')!;
        expect(JSON.parse(saved).state).toEqual({ apiKey: 'credential-sentinel', voice: 'custom_speaker', resourceId: 'seed-icl-2.0', asrResourceId: 'volc.seedasr.sauc.duration' });
        state.setApiKey('');
        localStorage.setItem('volcengine-speech', saved);
        await useVolcengineSpeechStore.persist.rehydrate();
        expect(useVolcengineSpeechStore.getState()).toMatchObject({ apiKey: 'credential-sentinel', voice: 'custom_speaker', resourceId: 'seed-icl-2.0' });
        state.setApiKey('');
        await useVolcengineSpeechStore.persist.rehydrate();
        expect(useVolcengineSpeechStore.getState().apiKey).toBe('');
        expect(localStorage.getItem('volcengine-speech')).not.toContain('credential-sentinel');
    });

    it.each(['local', 'openai-compatible', 'volcengine'])('preserves provider %s in bootstrap', (sttProvider) => {
        expect(parseSettingsBootstrap({ schemaVersion: 1, sttProvider })).toEqual({ schemaVersion: 1, sttProvider });
    });

    it('restores older preferences that have no saved key', async () => {
        localStorage.setItem('volcengine-speech', JSON.stringify({ state: { voice: 'older-speaker', resourceId: 'seed-tts-2.0' }, version: 0 }));
        await useVolcengineSpeechStore.persist.rehydrate();
        expect(useVolcengineSpeechStore.getState()).toMatchObject({ apiKey: '', voice: 'older-speaker', asrResourceId: 'volc.seedasr.sauc.duration' });
    });
});
