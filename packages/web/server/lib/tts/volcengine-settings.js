import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const defaults = {
  apiKey: '',
  voice: 'zh_female_vv_uranus_bigtts',
  resourceId: 'seed-tts-2.0',
  asrResourceId: 'volc.seedasr.sauc.duration',
};

const settingsPath = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR || path.join(os.homedir(), '.config', 'openchamber'),
  'speech', 'volcengine.json',
);

function normalizePatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid speech settings');
  const patch = {};
  for (const field of Object.keys(defaults)) {
    if (!Object.hasOwn(value, field)) continue;
    const text = value[field];
    if (typeof text !== 'string' || text.length > 4096 || /[\r\n\0]/.test(text) || (field !== 'apiKey' && !text.trim())) {
      throw new TypeError('Invalid speech settings');
    }
    patch[field] = text.trim();
  }
  return patch;
}

export function readVolcengineSettings() {
  try {
    return { ...defaults, ...normalizePatch(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...defaults };
    throw new Error('Unable to read speech settings');
  }
}

function publicSettings({ apiKey, ...preferences }) {
  return { ...preferences, configured: Boolean(apiKey) };
}

function saveSettings(patch) {
  const next = { ...readVolcengineSettings(), ...normalizePatch(patch) };
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

export function registerVolcengineSettingsRoutes(app) {
  app.get('/api/voice/volcengine', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      res.json(publicSettings(readVolcengineSettings()));
    } catch {
      res.status(500).json({ error: 'Unable to read speech settings' });
    }
  });
  app.put('/api/voice/volcengine', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      res.json(saveSettings(req.body));
    } catch (error) {
      res.status(error instanceof TypeError ? 400 : 500).json({
        error: error instanceof TypeError ? 'Invalid speech settings' : 'Unable to save speech settings',
      });
    }
  });
}
