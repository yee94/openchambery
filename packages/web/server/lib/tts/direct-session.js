import { readSpeechSettings } from './settings.js';

// The JWT is issued by the speech service, not by IAM/Ark. Never persist it.
export async function createSpeechTicket(settings, kind, signal) {
  const response = await fetch('https://openspeech.bytedance.com/api/v1/sts/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': settings.apiKey },
    body: JSON.stringify({ duration: 300 }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Speech ticket exchange failed');
  }
  let body = '';
  for await (const chunk of response.body ?? []) {
    body += Buffer.from(chunk).toString('utf8');
    if (body.length > 16384) throw new Error('Invalid speech ticket');
  }
  const { jwt_token: token } = JSON.parse(body);
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid speech ticket');
  // Metadata from the fixed, authenticated TLS issuer response; this is not a
  // verifier for client-supplied JWTs. The audience is the speech application ID.
  const { aud, exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (!Array.isArray(aud) || aud.length !== 1 || typeof aud[0] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(aud[0])
    || !Number.isInteger(exp) || exp <= now + 10 || exp > now + 360) throw new Error('Invalid speech ticket');
  const resourceId = kind === 'tts' ? settings.resourceId : settings.asrResourceId;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(resourceId)) throw new Error('Invalid speech resource');
  return {
    transport: 'volcengine-direct', token, appId: aud[0], expiresAt: exp * 1000, resourceId,
    ...(kind === 'tts' ? {
      voice: settings.voice, speed: settings.speechRate, pitch: settings.speechPitch, volume: settings.speechVolume,
    } : {}),
  };
}

export function registerDirectSpeechRoute(app) {
  app.post('/api/voice/session', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const kind = req.body?.kind;
    if (kind !== 'asr' && kind !== 'tts') return res.status(400).json({ error: 'Invalid speech session kind' });
    const abort = new AbortController();
    const cancel = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', cancel);
    try {
      const settings = readSpeechSettings();
      if ((kind === 'tts' ? settings.voiceProvider : settings.sttProvider) !== 'volcengine') {
        return res.json({ transport: 'host' });
      }
      if (!settings.apiKey) return res.status(400).json({ error: 'Volcengine speech API Key is required' });
      const ticket = await createSpeechTicket(settings, kind, abort.signal);
      if (!res.destroyed) res.json(ticket);
    } catch {
      if (!res.destroyed) res.status(502).json({ error: 'Unable to create speech session' });
    } finally {
      res.off('close', cancel);
    }
  });
}
