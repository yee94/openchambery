# TTS Module Documentation

## Purpose
This module provides server-side Text-to-Speech services using OpenAI's TTS API. The historical shared text summarization endpoint now lives in `packages/web/server/lib/text/` as an API-compatible stub because the previous Zen model provider is unavailable.

## Entrypoints and structure
- `volcengine.js`: Doubao speech adapter, using the speech console API Key (`X-Api-Key`), fixed upstream origin, bounded responses, timeout and cancellation. No Ark key, OpenAI credential fallback or server-side secret persistence.
- `packages/web/server/lib/tts/index.js`: Public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/tts/routes.js`: Express route registration for `/api/voice/*`, `/api/tts/*`, and `/api/stt/*` endpoints.
- `packages/web/server/lib/tts/capability-runtime.js`: runtime helper for probing local macOS `say` TTS voice capability.
- `packages/web/server/lib/tts/service.js`: TTS service implementation with OpenAI integration.
- `packages/web/server/lib/text/summarization.js`: Shared text summarization stub and sanitization utilities. It performs no external Zen calls.
- `packages/web/server/lib/tts/stt.js`: STT proxy for OpenAI-compatible transcription endpoints.
- `packages/web/server/lib/tts/base-url.js`: shared base URL validation and normalization for custom OpenAI-compatible endpoints.

## Public exports

### TTS Service (from service.js)
- `ttsService`: Singleton instance of TTSService class.
- `TTSService`: TTS service class for OpenAI audio generation.
- `TTS_VOICES`: Array of supported OpenAI voice identifiers.

### Shared text summarization (re-exported from ../text/summarization.js)
- `summarizeText({ text, threshold, maxLength, zenModel, mode })`: Retired shared text summarizer retained as a stub. TTS uses `mode: 'tts'`; `zenModel` is ignored.
- `sanitizeForTTS(text)`: Sanitizes text by removing markdown, URLs, file paths, and other non-speakable content.
- `sanitizeForNote(text)`: Re-exported for note-mode callers that still import through the TTS surface.

### Capability runtime (capability-runtime.js)
- `detectSayTtsCapability(processLike)`: probes local `say -v "?"` support and returns `{ available, voices, reason }`.

## Constants

### Voice identifiers
- `TTS_VOICES`: Array of supported OpenAI voices: `['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']`.

### Summarization defaults
- No model request timeout is used; the summarization provider is disabled.

### Default values
- `summarizeText` defaults: `threshold` = 200, `maxLength` = 500, `mode` = 'tts'. `zenModel` is ignored.
- `generateSpeechStream` defaults: `voice` = 'coral', `model` = 'gpt-4o-mini-tts', `speed` = 1.0.
- `generateSpeechBuffer` defaults: `voice` = 'coral', `model` = 'gpt-4o-mini-tts', `speed` = 1.0.

## TTSService methods

### `isAvailable()`
Returns a Promise of boolean after reading the current OpenCode selected credential.
Credential-source failure rejects; logout clears the previously constructed client.

### `generateSpeechStream(options)`
Generates speech and returns as a web stream for direct streaming to clients.
- Options: `text` (required), `voice`, `model`, `speed`, `instructions`, `apiKey`.
- Returns: `{ stream: ReadableStream, contentType: 'audio/mpeg' }`.
- Throws: Error if API key not configured or text is empty.

### `generateSpeechBuffer(options)`
Generates speech and returns as Buffer for caching purposes.
- Options: `text` (required), `voice`, `model`, `speed`, `instructions`.
- Returns: Buffer containing MP3 audio data.
- Throws: Error if API key not configured or text is empty.

## Response contracts

### `summarizeText`
Returns object with:
- `summary`: Sanitized or locally distilled fallback text.
- `summarized`: Always `false` while the model provider is unavailable.
- `reason`: String explaining why summarization was skipped.
- `originalLength`: Optional number for original text length.
- `summaryLength`: Optional number for summarized text length.

The route-level text summarize API is now `/api/text/summarize`.

### `sanitizeForTTS`
Returns sanitized string with markdown, URLs, file paths, and special characters removed.

### `generateSpeechStream`
Returns object with:
- `stream`: ReadableStream of MP3 audio data.
- `contentType`: Always 'audio/mpeg'.

### `generateSpeechBuffer`
Returns Buffer containing MP3 audio data.

## API key resolution
Explicit request API key/custom base URL remains supported. Otherwise the host
reads the current OpenCode credential API (`openai`, `codex`, `chatgpt` aliases),
using API `key` or OAuth `access`. There is no host-local environment/file fallback
that could substitute another account for a remote service. A credential read
failure propagates; selected-account changes replace the client and logout clears it.

## Usage in web server
The TTS module is used by `packages/web/server/index.js` for:
- Generating speech streams for client playback.
- Generating speech buffers for caching.
- Sanitizing text before TTS synthesis. Historical summarization calls now return local fallback text.
- Sanitizing text to remove non-speakable content.

The historical summarization API is shared with notifications and notes, but currently acts as a no-model fallback/stub.

The server-side TTS approach bypasses mobile Safari's audio context restrictions by generating audio on the server and streaming to clients.

## Notes for contributors

### Volcengine / Doubao

Settings → Voice provides a shared speech API Key, TTS resource ID and speaker ID.
The key and voice preferences auto-save to client-local storage on edit, matching
the other speech providers; no Save button is required. Clearing the key saves
the empty value. Existing preferences without a key remain compatible. Keys are
not synced between devices or stored by the Host. Select Volcengine separately
for read-aloud and dictation. Missing keys return HTTP 400, not a server failure.
Enable `seed-tts-2.0`, `volc.seedasr.sauc.duration` (live dictation),
and optionally `volc.bigasr.auc_turbo` (file API) in the
[speech console](https://console.volcengine.com/speech/new).
Defaults: `seed-tts-2.0`, `zh_female_vv_uranus_bigtts`, 24 kHz audio.
Settings treats Volcengine as a peer provider: enable playback or dictation,
then select it in that section's existing provider selector. Only the selected
channel's fields and tests render inline (TTS resource/speaker/preview versus
ASR resource/microphone tester). Both sections share the locally saved speech API Key.
Settings search points to the stable playback/recognition sections rather than
hidden provider fields; searching never changes the selected provider.
TTS resource and speaker controls use Select with a custom-ID input for existing
or cloned voices. `packages/ui/src/lib/voice/volcengine-catalog.ts` contains the
two documented 2.0 resources and 28 common official TTS 2.0 speakers, not the
account's entitlement list. Clone resources never show public TTS speakers.
The official [ListSpeakers API](https://www.volcengine.com/docs/DoubaoVoice/ListSpeakers-LargeModelSoundListNewInterface?lang=zh)
(`2025-05-20`, `ResourceIDs`, `Page`, `Limit`) requires account AK/SK HMAC signing
at `open.volcengineapi.com` for `speech_saas_prod`; the speech `X-Api-Key` cannot
authenticate this management API. No live-list endpoint or extra credentials are
added. The catalog is a documented snapshot and custom IDs remain editable.
The default speaker is **Vivi 2.0**, listed among the official flagship S2S
voices in the [voice catalog](https://www.volcengine.com/docs/6561/1257544?lang=zh).
For this default resource/speaker pair, `additions.context_texts` requests natural,
warm delivery with text-appropriate emotion, pauses and emphasis. This is our
delivery instruction, not a separate official “recommended emotional voice” ID.
Custom/cloned speakers do not inherit this speaker-specific instruction.
Custom speaker/resource pairs must belong to the same enabled model/service.

`POST /api/tts/speak` accepts `{provider: 'volcengine', text, apiKey, resourceId?,
voice?, speed?, stream?}`. With `stream: true`, the adapter requests mono PCM
(signed 16-bit little-endian, 24 kHz), incrementally parses upstream JSON and
forwards `application/x-ndjson` frames: `{type:'audio',data:<base64>}`, then
`{type:'done'}` only after terminal upstream success. Each audio frame is at most
9600 bytes. A failure after headers emits `{type:'error',error:<safe message>}`;
missing completion and truncated samples are errors, never successful playback.
The route disables proxy/compression buffering, honors write backpressure and
aborts upstream when the client disconnects. Responses remain bounded at 32 MiB.

`packages/ui/src/lib/voice/pcm-stream.ts` schedules PCM directly on the unlocked
Web Audio context with a 400 ms startup buffer measured in actual playback time
(including pitch-induced speed changes). If the scheduled timeline runs out of
its 20 ms safety margin, it accumulates another 400 ms before resuming, rather
than playing isolated packets. Terminal success flushes short replies and any
remaining tail below that threshold. Scheduled audio remains bounded to
approximately two seconds; the additional unscheduled buffer is bounded to the
400 ms target plus one frame. It does not wait for EOF or MP3 decoding. Source nodes are
released on completion; stop, runtime switch, unmount and errors cancel the
reader and queued audio. Playback completion waits for both terminal success
and the last source's `ended` event, preserving automatic read-aloud ordering.
The HTTP stream uses `runtimeFetch`, including the existing encrypted Relay
transport. Relay may buffer transport bytes independently of the audio scheduler.
No native plugin or MediaSource support is required.

Existing clients without `stream: true` still receive complete MP3 bytes after
terminal success, and new clients can play MP3 from older Hosts during upgrades.
Speed 0.5–2 maps to upstream -50–100; pitch and volume remain client-side.

`POST /api/stt/transcribe` accepts raw WAV/MP3/OGG (20 MB maximum) with
`X-Speech-Provider: volcengine` and `X-Speech-Api-Key`. Runtime Authorization
remains independent. ASR uses the flash endpoint with base64 audio and resource
`volc.bigasr.auc_turbo`; only explicit silence returns an empty transcript.
The Settings microphone tester uses the live dictation route instead of this file API.
Normal microphone input uses the dictation session adapter described in
`../dictation/DOCUMENTATION.md`.

Web, Electron, hosted mobile and Capacitor use the existing runtime HTTP and
dictation WebSocket transports (including Relay). VS Code has no speech host and
returns explicit 501 for synthesis/file transcription, as for existing dictation.

Protocol sources (checked October 2026):
- [HTTP synthesis and API Key authentication](https://www.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)
- [V3 chunked completion codes](https://www.volcengine.com/docs/6561/1598757)
- [Flash ASR and Python example](https://www.volcengine.com/docs/DoubaoVoice/LargemodelrecordingfileLiterecognitionAPI?lang=zh)

Validation: protocol, route and cancellation tests use mocked upstream responses.
The compiled Relay integration test (`../relay/relay-server.e2e.test.ts`) also
exercises the real TTS route through `runtimeFetch`, bearer auth, Host forwarding
and the encrypted tunnel. Only the external synthesizer is mocked. It verifies
audio arrival before upstream completion, terminal success/error delivery and
client cancellation reaching the upstream signal. This does not measure mobile
device playback or latency against the live speech service.
For live validation, enter a speech API Key in Settings, preview TTS, then open
the microphone tester and record/confirm speech. It displays live captions,
input level, elapsed time and final text without sending a chat message.
Closing, backgrounding and runtime changes cancel recording; unmount fences late results.
Test cancel/retry separately. TTS and streaming ASR must be enabled;
unit tests and builds do not establish live account permissions or audio quality.
An opt-in TTS → ASR round-trip test is available with
`bunx vitest run --project @openchamber/web packages/web/server/lib/tts/volcengine.live.test.js`.
Set `VOLCENGINE_SPEECH_API_KEY` in the invoking environment; without it the test
is skipped. It generates a short Chinese sentence, recognizes the resulting MP3,
and checks key words. It uses the account's enabled services/billing.

### Adding new TTS features
1. Add new methods to `packages/web/server/lib/tts/service.js` TTSService class.
2. Export public functions from `packages/web/server/lib/tts/index.js`.
3. Follow existing patterns for API key resolution and error handling.
4. Ensure all text is sanitized before TTS synthesis.
5. Consider adding new voice options to `TTS_VOICES` constant.

### Text sanitization
- Always call `sanitizeForTTS` on text before passing to TTS generation.
- The sanitization removes markdown, code blocks, URLs, file paths, shell commands, and special characters.
- This prevents the TTS from reading out technical formatting that sounds unnatural.

### Error handling
- `generateSpeechStream` and `generateSpeechBuffer` throw descriptive errors for missing API keys or empty text.
- `summarizeText` does not call Zen and returns mode-specific fallback text with `summarized: false`.
- All errors are logged to console with `[TTSService]` or `[Summarize]` prefix.

### API key management
- TTSService caches OpenAI client instance and recreates when API key changes.
- API key changes are detected by comparing with `_lastApiKey` property.
- This allows dynamic API key updates without server restart.

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Test API key resolution with environment variable and auth file.
- Test speech generation with various text lengths and voice options.
- Test summarization stub behavior above and below threshold.
- Test sanitization with markdown, URLs, and code blocks.
- Verify streaming and buffer generation produce valid MP3 audio.

## Verification notes

### Manual verification
1. Configure OpenAI API key via environment variable or OpenCode settings.
2. Test `ttsService.isAvailable()` returns true.
3. Call `ttsService.generateSpeechStream({ text: 'Hello world' })` and verify stream is returned.
4. Call `ttsService.generateSpeechBuffer({ text: 'Hello world' })` and verify Buffer is returned.
5. Test `summarizeText` with text above and below threshold.
6. Test `sanitizeForTTS` with markdown, URLs, and code blocks.

### API endpoint verification
1. Start web server and access TTS endpoint via client.
2. Verify audio plays correctly in browser.
3. Test on mobile Safari to verify bypass of audio context restrictions.
4. Test with long messages to verify summarization is triggered.
