# Dictation module

Server-authoritative streaming speech-to-text for the chat composer, plus
local text-to-speech. The client streams 16 kHz mono PCM16 chunks (base64)
over a WebSocket; the server runs the transcription and streams live partial
transcripts back.

Local TTS (Kokoro via sherpa-onnx OfflineTts) runs in the same worker process
and is exposed as `POST /api/dictation/tts/speak` (JSON `{text, speakerId?,
speed?, model?}` → WAV bytes; 503 with `reasonCode` while the model is
downloading). TTS models live in the same catalog/downloader as STT models
(`local/model-catalog.js` `LOCAL_TTS_MODEL_CATALOG`) and are managed by the
same status/download/delete routes.

## Ownership

- `runtime.js` — registers `GET /api/dictation/status`,
  `POST /api/dictation/models/:modelId/download`, and the
  `/api/dictation/ws` WebSocket endpoint (auth-gated the same way as the
  terminal WS: UI session token or `oc_url_token`, plus origin check).
  Created from the startup pipeline (`startup-pipeline-runtime.js`) before
  the generic OpenCode proxy so routes are not shadowed.
- `stream-manager.js` — `DictationStreamManager`, one per WS connection.
  Chunk reordering by `seq` + ack, resampling to the provider rate,
  auto-commit every ~15 s of audio, silence suppression by PCM peak,
  partial-transcript concatenation, adaptive finalization timeout.
- `service.js` — provider resolution and readiness. Providers:
  - `local` (default): sherpa-onnx Parakeet TDT in a forked worker process.
    Models auto-download in the background on first use; while missing, the
    stream fails with `reasonCode: 'model_download_in_progress'` and the
    status route reports per-model install/download state.
  - `openai-compatible`: buffered per-segment transcription against any
    OpenAI-compatible `/v1/audio/transcriptions` endpoint
    (`openai-compatible-session.js`, reuses `../tts/stt.js`).
   - `volcengine`: live PCM over Doubao's binary/gzip WebSocket protocol
     (`volcengine-session.js`, `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`).
     Defaults to `volc.seedasr.sauc.duration` (2.0); the corresponding concurrent
     resource and 1.0 `volc.bigasr.sauc.*` resources are also accepted.
     Full-text partials replace the same segment's caption. Auto-commit is disabled;
     explicit finish sends the last audio frame and waits for a final response.
     Unexpected closure is failure, never successful empty recognition. Closing
     terminates the upstream socket and ignores late responses.
     A successful terminal frame may omit `result.text`; it then finalizes the
     last full-text response received in this session. Explicit text (including
     empty text) replaces that snapshot. No terminal frame means failure even
     when partial text was received.
- `local/` — worker process + client (IPC, idle shutdown TTL), sherpa
  recognizer engine and realtime session (throttled re-decode for partials),
  model catalog and downloader. The native `sherpa-onnx-node` addon is only
  ever loaded inside the worker process.
- `audio.js` — PCM16 helpers: format parsing, peak, WAV wrapping, streaming
  linear resampler.

## WebSocket protocol (JSON text frames)

Client → server: `start {dictationId, format, options}`,
`chunk {dictationId, seq, audio}`, `finish {dictationId, finalSeq}`,
`cancel {dictationId}`, `ping`.

Server → client: `ready`, `ack {ackSeq}`, `partial {text}`,
`finish_accepted {timeoutMs}`, `final {text}`,
`error {error, retryable, reasonCode?}`, `pong`.

`options` in `start` carries the client-selected provider config:
`{ provider: 'local' | 'openai-compatible' | 'volcengine', language?, localModel?,
openaiCompatible?: { baseUrl, model, apiKey }, volcengine?: { apiKey, resourceId? } }`.
Volcengine uses automatic language recognition; the Whisper language hint is
not forwarded. Credentials live only for the request/session and are not logged.

## Invariants

- Cancelled pending starts cannot install a late-connected session.
- Microphone capture sends 200 ms chunks; file tests remain on flash ASR and do
  not validate streaming-service permissions.
- Mobile ASR uses `HoldToTalkComposer`: press to record, move up 64 CSS pixels
  to arm cancellation (move back to resume), release to send the final text.
  Pointer cancellation, focus loss, backgrounding and draft changes discard
  recording. Live captions and volume state stay inside this leaf component.
  Keyboard mode preserves the draft; ASR-enabled iOS uses the web composer
  instead of the native overlay. Other providers retain their own caption cadence.
- Streaming protocol references:
  https://www.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh
  and https://www.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh.

- Never load `sherpa-onnx-node` in the main server process.
- The stream manager acks only the highest contiguous seq; the client is
  expected to retain unacked segments for retry/replay.
- Silence-only segments (peak < 300) are cleared, never committed, so
  Whisper-style providers do not hallucinate on silence.
- Model files live under `~/.config/openchamber/speech-models`.

## Relay streaming verification

`../relay/relay-server.e2e.test.ts` exercises the real dictation runtime,
stream manager and Volcengine binary adapter through a compiled Relay process.
The client uses `openRuntimeWebSocket` with a freshly minted URL token; real
auth/origin checks remain enabled. Only the external speech WebSocket is
redirected to a local protocol fixture. The test checks that a 200 ms PCM chunk
arrives unchanged, a partial caption arrives before finish, finish returns the
corrected final text, and cancellation closes upstream without a final result.
This establishes transport streaming, not real-device microphone quality or
live-service recognition latency.
