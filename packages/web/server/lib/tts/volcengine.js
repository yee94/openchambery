import { randomUUID } from 'node:crypto';

const ORIGIN = 'https://openspeech.bytedance.com';
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function headers(apiKey, resourceId) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
    throw new Error('Volcengine speech API Key is required');
  }
  if (typeof resourceId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(resourceId)) {
    throw new Error('Invalid Volcengine resource ID');
  }
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey.trim(),
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': randomUUID(),
  };
}

async function readBody(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Volcengine HTTP ${response.status}; check the speech API Key and enabled service`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error('Volcengine response exceeds the audio size limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseResponse(body) {
  try { return JSON.parse(body); }
  catch { throw new Error('Invalid Volcengine JSON response'); }
}

async function* responseLines(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Volcengine HTTP ${response.status}; check the speech API Key and enabled service`);
  }
  const decoder = new TextDecoder();
  let pending = '';
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error('Volcengine response exceeds the audio size limit');
    pending += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      if (line) yield line;
    }
    if (pending.length > 1024 * 1024) throw new Error('Volcengine audio frame exceeds the size limit');
  }
  pending += decoder.decode();
  if (pending.trim()) yield pending.trim();
}

export async function synthesizeVolcengine({ text, apiKey, resourceId = 'seed-tts-2.0', voice = 'zh_female_vv_uranus_bigtts', speed = 1, signal, onAudio }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 10000) {
    throw new Error('Speech text must contain 1–10000 characters');
  }
  if (typeof voice !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(voice)) throw new Error('Invalid Volcengine speaker ID');
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('Volcengine speech speed must be between 0.5 and 2');
  const response = await fetch(`${ORIGIN}/api/v3/tts/unidirectional`, {
    method: 'POST',
    headers: headers(apiKey, resourceId),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
    body: JSON.stringify({
      user: { uid: 'openchamber' },
      req_params: {
        text: text.trim(),
        speaker: voice,
        audio_params: { format: onAudio ? 'pcm' : 'mp3', sample_rate: 24000, speech_rate: Math.round((speed - 1) * 100) },
        ...(resourceId === 'seed-tts-2.0' && voice === 'zh_female_vv_uranus_bigtts' ? {
          additions: JSON.stringify({ context_texts: ['请用自然、温暖的对话语气朗读，根据文本内容表达恰当的情感，保持清晰自然的停顿与重音，避免夸张的播音腔。'] }),
        } : {}),
      },
    }),
  });
  const audio = [];
  let audioBytes = 0;
  let finished = false;
  for await (const line of responseLines(response)) {
    const item = parseResponse(line);
    if (item.code !== 0 && item.code !== 20000000) {
      throw new Error(`Volcengine TTS failed (code ${Number(item.code) || 'unknown'}); check resource ID and speaker permissions`);
    }
    if (typeof item.data === 'string' && item.data) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) throw new Error('Invalid Volcengine audio encoding');
      const chunk = Buffer.from(item.data, 'base64');
      audioBytes += chunk.length;
      if (onAudio) await onAudio(chunk);
      else audio.push(chunk);
    }
    if (item.code === 20000000) { finished = true; break; }
  }
  if (!finished) throw new Error('Volcengine audio response ended before synthesis completed');
  if (!audioBytes) throw new Error('Volcengine returned no audio');
  if (onAudio) return;
  const buffer = Buffer.concat(audio);
  return { buffer, contentType: 'audio/mpeg' };
}

export async function transcribeVolcengine({ audioBuffer, apiKey, signal }) {
  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length || audioBuffer.length > 20 * 1024 * 1024) {
    throw new Error('Volcengine audio must contain 1–20 MB of WAV, MP3 or OGG data');
  }
  const response = await fetch(`${ORIGIN}/api/v3/auc/bigmodel/recognize/flash`, {
    method: 'POST',
    headers: { ...headers(apiKey, 'volc.bigasr.auc_turbo'), 'X-Api-Sequence': '-1' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
    body: JSON.stringify({ user: { uid: 'openchamber' }, audio: { data: audioBuffer.toString('base64') }, request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true } }),
  });
  const body = await readBody(response);
  const status = response.headers.get('x-api-status-code');
  if (status === '20000003') return '';
  if (status !== '20000000') throw new Error(`Volcengine ASR failed (code ${/^\d+$/.test(status ?? '') ? status : 'unknown'}); check API Key and volc.bigasr.auc_turbo permissions`);
  const result = parseResponse(body);
  if (typeof result?.result?.text !== 'string') throw new Error('Volcengine returned an invalid transcript');
  return result.result.text;
}
