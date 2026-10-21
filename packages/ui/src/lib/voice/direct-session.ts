import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';

export interface SpeechTicket {
  transport: 'volcengine-direct';
  token: string;
  appId: string;
  expiresAt: number;
  resourceId: string;
  asrContext?: string;
  voice?: string;
  speed?: number;
  pitch?: number;
  volume?: number;
}

// Session creation is a mutation. Tickets live only in the active operation,
// never in Query, storage, or a cross-runtime credential cache.
export async function requestSpeechSession(kind: 'asr' | 'tts', signal: AbortSignal): Promise<SpeechTicket | null> {
  const identity = getRuntimeTransportIdentity();
  const response = await runtimeFetch('/api/voice/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind }), signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  signal.throwIfAborted();
  if (identity !== getRuntimeTransportIdentity()) throw new Error('Speech runtime changed');
  // Older Hosts do not expose session creation yet (some serve the SPA).
  if (response.status === 404 || (response.ok && response.headers.get('content-type')?.includes('text/html'))) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) { await response.body?.cancel(); throw new Error('Unable to create speech session'); }
  const value = await response.json();
  signal.throwIfAborted();
  if (identity !== getRuntimeTransportIdentity()) throw new Error('Speech runtime changed');
  if (value?.transport === 'host') return null;
  if (value?.transport !== 'volcengine-direct' || typeof value.token !== 'string' || value.token.length > 16384
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.token)
    || typeof value.appId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.appId)
    || typeof value.resourceId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.resourceId)
    || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() + 5000
    || value.expiresAt > Date.now() + 360000) throw new Error('Invalid speech session');
  if (kind === 'tts' && (typeof value.voice !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value.voice)
    || !Number.isFinite(value.speed) || value.speed < 0.5 || value.speed > 2
    || !Number.isFinite(value.pitch) || value.pitch < 0.5 || value.pitch > 2
    || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1)) throw new Error('Invalid speech session');
  if (kind === 'asr' && value.asrContext !== undefined
    && (typeof value.asrContext !== 'string' || value.asrContext.length > 2000 || /\0/.test(value.asrContext))) throw new Error('Invalid speech session');
  return value as SpeechTicket;
}

export function speechSocketUrl(ticket: SpeechTicket, kind: 'asr' | 'tts'): string {
  const url = new URL(kind === 'asr'
    ? 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
    : 'wss://openspeech.bytedance.com/api/v3/tts/bidirection');
  url.search = new URLSearchParams({
    api_app_key: ticket.appId, api_access_key: `Jwt; ${ticket.token}`, api_resource_id: ticket.resourceId,
  }).toString();
  return url.toString();
}
