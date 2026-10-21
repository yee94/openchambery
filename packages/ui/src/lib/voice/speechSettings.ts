export const speechDefaults = {
    asrContext: 'The speaker is discussing software development and technical tasks with an AI assistant. Speech may mix Mandarin Chinese and English within the same sentence. The conversation may cover requirements, system design, implementation, debugging, testing, deployment, and maintenance. Common software engineering terms include alpha, beta, release, stable, version, build, branch, commit, merge, pull request, code review, bug, fix, hotfix, patch, refactor, rollback, deploy, CI/CD, API, SDK, and CLI. Technical terms, product names, acronyms, and code identifiers may be spoken in English within otherwise Chinese sentences.',
    showMessageTTSButtons: false,
    voiceProvider: 'browser' as 'browser' | 'local' | 'openai' | 'openai-compatible' | 'say' | 'volcengine',
    speechRate: 1, speechPitch: 1, speechVolume: 1,
    ttsInputMode: 'final' as 'final' | 'sanitized' | 'raw' | 'summarized',
    sayVoice: 'Samantha', localTtsVoiceId: 0, browserVoice: '',
    openaiVoice: 'nova', openaiApiKey: '', openaiApiKeyConfigured: false,
    openaiCompatibleUrl: '', openaiCompatibleApiKey: '', openaiCompatibleApiKeyConfigured: false,
    openaiCompatibleVoice: 'af_sky', openaiCompatibleTtsModel: 'kokoro',
    dictationEnabled: false,
    sttProvider: 'local' as 'local' | 'openai-compatible' | 'volcengine',
    sttServerUrl: 'http://localhost:8001/v1', sttApiKey: '', sttApiKeyConfigured: false,
    sttModel: 'deepdml/faster-whisper-large-v3-turbo-ct2', sttLocalModel: 'parakeet-tdt-0.6b-v2-int8', sttLanguage: '',
    summarizeMessageTTS: false, summarizeVoiceConversation: false, summarizeCharacterThreshold: 200, summarizeMaxLength: 500,
    configured: false, apiKey: '', voice: 'zh_female_vv_uranus_bigtts', resourceId: 'seed-tts-2.0', asrResourceId: 'volc.seedasr.sauc.duration',
};

export type SpeechSettings = typeof speechDefaults;
export type SpeechSettingsPatch = Partial<Omit<SpeechSettings, 'configured' | 'openaiApiKeyConfigured' | 'openaiCompatibleApiKeyConfigured' | 'sttApiKeyConfigured'>>;

export const speechSecretFields = new Set(['apiKey', 'openaiApiKey', 'openaiCompatibleApiKey', 'sttApiKey']);

export function parseSpeechSettings(value: unknown): SpeechSettings {
    if (!value || typeof value !== 'object') throw new Error('Invalid speech settings');
    const record = value as Record<string, unknown>;
    const result = { ...speechDefaults };
    for (const key of Object.keys(speechDefaults) as Array<keyof SpeechSettings>) {
        if (speechSecretFields.has(key)) continue;
        if (key === 'asrContext' && record[key] === undefined) { result.asrContext = ''; continue; }
        if (typeof record[key] !== typeof speechDefaults[key]) throw new Error('Invalid speech settings');
        Object.assign(result, { [key]: record[key] });
    }
    if (!['browser', 'local', 'openai', 'openai-compatible', 'say', 'volcengine'].includes(result.voiceProvider)
        || !['local', 'openai-compatible', 'volcengine'].includes(result.sttProvider)
        || !['final', 'sanitized', 'raw', 'summarized'].includes(result.ttsInputMode)) throw new Error('Invalid speech settings');
    return result;
}
