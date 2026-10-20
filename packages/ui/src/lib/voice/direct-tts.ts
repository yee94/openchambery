import { runtimeFetch } from '@/lib/runtime-fetch';
import { requestSpeechSession, speechSocketUrl, type SpeechTicket } from './direct-session';
import { decodeSpeechFrame, openSpeechSocket, speechJson, ttsFrame } from './volcengine-protocol';

async function* synthesize(ticket: SpeechTicket, text: string, signal: AbortSignal): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const socket = await openSpeechSocket(speechSocketUrl(ticket, 'tts'), signal);
  const sessionId = crypto.randomUUID();
  const encoder = new TextEncoder();
  const params = {
    speaker: ticket.voice,
    audio_params: { format: 'pcm', sample_rate: 24000, speech_rate: Math.round((ticket.speed! - 1) * 100) },
    ...(ticket.resourceId === 'seed-tts-2.0' && ticket.voice === 'zh_female_vv_uranus_bigtts' ? {
      additions: JSON.stringify({ context_texts: ['请用自然、温暖的对话语气朗读，根据文本内容表达恰当的情感，保持清晰自然的停顿与重音，避免夸张的播音腔。'] }),
    } : {}),
  };
  const payload = (event: number, withText = false) => ({
    user: { uid: 'openchamber' }, namespace: 'BidirectionalTTS', event,
    req_params: { ...params, ...(withText ? { text } : {}) },
  });
  let state: 'connection' | 'session' | 'audio' = 'connection';
  let bytes = 0;
  try {
    socket.send(ttsFrame(1));
    while (true) {
      const frame = await decodeSpeechFrame(await socket.read(), 'tts');
      signal.throwIfAborted();
      if (frame.event === 51 || frame.event === 153 || frame.event === 151) throw new Error('Speech synthesis failed');
      if (frame.event >= 100 && frame.sessionId !== sessionId) throw new Error('Unexpected speech session');
      if (frame.event === 50 && state === 'connection') {
        state = 'session';
        socket.send(ttsFrame(100, sessionId, payload(100)));
      } else if (frame.event === 150 && state === 'session') {
        state = 'audio';
        socket.send(ttsFrame(200, sessionId, payload(200, true)));
        socket.send(ttsFrame(102, sessionId));
      } else if (frame.event === 352 && state === 'audio' && frame.type === 11) {
        bytes += frame.payload.length;
        if (bytes > 32 * 1024 * 1024) throw new Error('Speech audio exceeds size limit');
        for (let offset = 0; offset < frame.payload.length; offset += 9600) {
          const chunk = frame.payload.subarray(offset, offset + 9600);
          let binary = '';
          for (const byte of chunk) binary += String.fromCharCode(byte);
          yield encoder.encode(`${JSON.stringify({ type: 'audio', data: btoa(binary) })}\n`);
        }
      } else if (frame.event === 152 && state === 'audio') {
        const result = speechJson(frame.payload);
        if (result.status_code !== undefined && result.status_code !== 0 && result.status_code !== 20000000) throw new Error('Speech synthesis failed');
        if (!bytes) throw new Error('Speech returned no audio');
        // SessionFinished already authoritatively completed synthesis. A peer
        // that closed immediately afterwards does not need FinishConnection.
        try { socket.send(ttsFrame(2)); } catch { /* Socket is closed in finally. */ }
        yield encoder.encode('{"type":"done"}\n');
        return;
      } else if (frame.event !== 350 && frame.event !== 351) {
        throw new Error('Unexpected speech synthesis event');
      }
    }
  } finally { socket.close(); }
}

export async function requestSpeechAudio(text: string, signal: AbortSignal): Promise<Response> {
  if (!text.trim()) throw new Error('Speech text is required');
  const ticket = await requestSpeechSession('tts', signal);
  if (!ticket) return runtimeFetch('/api/tts/speak', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson, audio/*' },
    body: JSON.stringify({ text: text.trim() }), signal,
  });
  if (text.length > 10000) throw new Error('Speech text must contain 1–10000 characters');
  const cancel = new AbortController();
  const iterator = synthesize(ticket, text.trim(), AbortSignal.any([signal, cancel.signal]));
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { cancel.abort(); await iterator.return(undefined); },
  });
  return new Response(body, { headers: {
    'Content-Type': 'application/x-ndjson', 'X-Speech-Pitch': String(ticket.pitch), 'X-Speech-Volume': String(ticket.volume),
  } });
}
