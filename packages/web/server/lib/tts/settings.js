import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const defaults = {
  apiKey: '',
  voice: 'zh_female_vv_uranus_bigtts',
  resourceId: 'seed-tts-2.0',
  asrResourceId: 'volc.seedasr.sauc.duration',
  showMessageTTSButtons: false,
  voiceProvider: 'browser',
  speechRate: 1,
  speechPitch: 1,
  speechVolume: 1,
  ttsInputMode: 'final',
  sayVoice: 'Samantha',
  localTtsVoiceId: 0,
  browserVoice: '',
  openaiVoice: 'nova',
  openaiApiKey: '',
  openaiCompatibleUrl: '',
  openaiCompatibleApiKey: '',
  openaiCompatibleVoice: 'af_sky',
  openaiCompatibleTtsModel: 'kokoro',
  dictationEnabled: false,
  sttProvider: 'local',
  sttServerUrl: 'http://localhost:8001/v1',
  sttApiKey: '',
  sttModel: 'deepdml/faster-whisper-large-v3-turbo-ct2',
  sttLocalModel: 'parakeet-tdt-0.6b-v2-int8',
  sttLanguage: '',
  summarizeMessageTTS: false,
  summarizeVoiceConversation: false,
  summarizeCharacterThreshold: 200,
  summarizeMaxLength: 500,
};

const enums = {
  voiceProvider: ['browser', 'local', 'openai', 'openai-compatible', 'say', 'volcengine'],
  sttProvider: ['local', 'openai-compatible', 'volcengine'],
  ttsInputMode: ['final', 'sanitized', 'raw', 'summarized'],
};
const ranges = { speechRate: [0.5, 2], speechPitch: [0.5, 2], speechVolume: [0, 1], localTtsVoiceId: [0, 10000], summarizeCharacterThreshold: [50, 2000], summarizeMaxLength: [50, 2000] };
const requiredStrings = new Set(['voice', 'resourceId', 'asrResourceId']);
const settingsPath = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR || path.join(os.homedir(), '.config', 'openchamber'),
  'speech', 'settings.json',
);

function normalizePatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid speech settings');
  const patch = {};
  for (const field of Object.keys(defaults)) {
    if (!Object.hasOwn(value, field)) continue;
    const input = value[field];
    if (typeof input !== typeof defaults[field]
      || (typeof input === 'string' && (input.length > 4096 || /[\r\n\0]/.test(input) || (requiredStrings.has(field) && !input.trim())))
      || (enums[field] && !enums[field].includes(input))
      || (typeof input === 'number' && (!Number.isFinite(input) || input < ranges[field][0] || input > ranges[field][1]))) {
      throw new TypeError('Invalid speech settings');
    }
    patch[field] = typeof input === 'string' ? input.trim() : input;
  }
  return patch;
}

export function readSpeechSettings() {
  try {
    return { ...defaults, ...normalizePatch(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))) };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      try {
        const readLegacy = (file) => {
          try { return normalizePatch(JSON.parse(fs.readFileSync(file, 'utf8'))); }
          catch (legacyError) { if (legacyError?.code === 'ENOENT') return {}; throw legacyError; }
        };
        const directory = path.dirname(settingsPath());
        return { ...defaults, ...readLegacy(path.join(directory, '..', 'settings.json')), ...readLegacy(path.join(directory, 'volcengine.json')) };
      } catch { /* Never replace an unreadable persisted configuration with defaults. */ }
    }
    throw new Error('Unable to read speech settings');
  }
}

function publicSettings({ apiKey, openaiApiKey, openaiCompatibleApiKey, sttApiKey, ...preferences }) {
  return { ...preferences, configured: Boolean(apiKey), openaiApiKeyConfigured: Boolean(openaiApiKey), openaiCompatibleApiKeyConfigured: Boolean(openaiCompatibleApiKey), sttApiKeyConfigured: Boolean(sttApiKey) };
}

function saveSettings(patch) {
  const next = { ...readSpeechSettings(), ...normalizePatch(patch) };
  const target = settingsPath();
  const directory = path.dirname(target);
  const temporary = `${target}.${randomUUID()}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  try {
    fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return publicSettings(next);
}

export function registerSpeechSettingsRoutes(app) {
  app.get(['/api/voice/settings', '/api/voice/volcengine'], (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      res.json(publicSettings(readSpeechSettings()));
    } catch {
      res.status(500).json({ error: 'Unable to read speech settings' });
    }
  });
  app.put(['/api/voice/settings', '/api/voice/volcengine'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const saved = saveSettings(req.body);
      res.json(saved);
      app.emit('openchamber:speech-settings-changed');
    } catch (error) {
      res.status(error instanceof TypeError ? 400 : 500).json({
        error: error instanceof TypeError ? 'Invalid speech settings' : 'Unable to save speech settings',
      });
    }
  });
}
