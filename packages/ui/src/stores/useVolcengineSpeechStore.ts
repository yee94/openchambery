import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface VolcengineSpeechState {
    apiKey: string;
    voice: string;
    resourceId: string;
    asrResourceId: string;
    setApiKey: (apiKey: string) => void;
    setVoice: (voice: string) => void;
    setResourceId: (resourceId: string) => void;
    setAsrResourceId: (asrResourceId: string) => void;
}

// Auto-save locally, matching the other speech providers' API Key settings.
export const useVolcengineSpeechStore = create<VolcengineSpeechState>()(persist((set) => ({
    apiKey: '',
    voice: 'zh_female_vv_uranus_bigtts',
    resourceId: 'seed-tts-2.0',
    asrResourceId: 'volc.seedasr.sauc.duration',
    setApiKey: (apiKey) => set({ apiKey }),
    setVoice: (voice) => set({ voice }),
    setResourceId: (resourceId) => set({ resourceId }),
    setAsrResourceId: (asrResourceId) => set({ asrResourceId }),
}), {
    name: 'volcengine-speech',
    partialize: ({ apiKey, voice, resourceId, asrResourceId }) => ({ apiKey, voice, resourceId, asrResourceId }),
}));
