# OpenChamber LLM Gateway

OpenAI-shaped Chat Completions for the in-app Assistant contact. This is the
only model path the Assistant harness (`pi-agent-core` `streamFn`) talks to.

## Contract

- `GET /api/openchamber/llm/models` — connected `{providerID, modelID}` catalog
  from OpenCode `GET /provider` (`connected`) plus `GET /config/providers`.
  Plugin adapter formats stay inside OpenCode; this route does not parse them.
- `POST /api/openchamber/llm/chat/completions` — `{ model, messages, stream?,
  providerID?, modelID? }` → OpenAI `chat.completion` JSON.
  This **public** gateway is **non-streaming**. Bundled OpenCode 1.18.4 generate
  (`POST /generate` when present, otherwise throwaway `session.promptAsync`
  plus idle wait) returns a full assistant turn. `stream: true` is rejected with
  `validation_error` (HTTP 400). Do not emit fake SSE after the fact on this
  route (never typewrite a completed string into tokens over HTTP).
  The contact UI may stream later via a **server-internal** path only (below).

`model` may be `providerID/modelID` or a bare `modelID` paired with `providerID`.

## Internals (verified on bundled `@opencode-ai/sdk` 1.18.4)

The 1.18.4 client exposes `GET /provider`, `GET /config/providers`, and
`session.prompt` / `session.promptAsync`. It does **not** expose
`POST /api/generate` or any other sessionless generate method.

1. Probe `POST /generate` (and SDK `generate` if present). Use it only when
   the response is JSON (`Content-Type` or a JSON object body). SPA / OpenCode
   HTML `200 <!doctype` is not generate — fall through to the throwaway path.
   Bundled 1.18.4 has no sessionless generate.
2. Otherwise create a throwaway archived OpenCode session, deny every tool
   (`client.tool.ids()` → `{ [id]: false }`), send our messages as
   `system` + user text via `session.promptAsync` (v2 `session.prompt` only
   forwards `{ id, prompt, delivery, resume }` and drops `model`/`parts` —
   that produced empty assistant text and a 502). Contact file parts reuse the
   existing OpenCode `{ type: 'file', mime, url, filename? }` delivery shape
   (data URLs in the contact SQLite store — not a second attachment store) and
   are forwarded on `promptAsync` only when the connected catalog marks that
   model as image-capable (`modalities.input`, `input`, or `attachment`).
   Non-vision models (for example deepseek-v4-flash) keep the `[image: …]`
   description and any text-file bytes, and skip image data URLs so generate
   cannot stall on unsupported vision parts. Non-image
    text files are also inlined into the flattened prompt. Wait for idle via
    `session.status` + `session.messages`, then delete the session. Throwaway
    sessions are created with
    `metadata.openchamber.llm.purpose = 'chat-completions'` (and archived
    immediately) so sidebar visibility, session-index, session-title, and
    notification/push fanout treat them as system-owned — same contract as
    non-empty `smallModel.purpose`. This is a text generator only — never the
    contact transcript and never a coding SessionPrompt loop. Upstream
    `info.error.message` is forwarded on 502.

### Internal token callback (in-process only)

`generateOpenCodeText` / `createChatCompletion` accept optional
`onTextDelta(text: string)` and `globalEventHub` (the shared
`globalMessageStreamHub` / `subscribeEvent` surface).

- **Throwaway session path:** after archive, before `promptAsync`, subscribe to
  the hub. Forward real OpenCode `message.part.delta` events whose
  `properties.sessionID` matches this throwaway session, `field` is `text`
  (or omitted), and `messageID` matches the first assistant message locked for
  that generate. Still wait for idle and return the **full** text (strip/parse
  needs the complete string). Unsubscribe in `finally` so failed generates
  cannot leak listeners.
- **Sessionless `/generate` JSON path:** cannot emit live deltas — skip
  `onTextDelta` honestly (no fake typewriter of the completed string).
- **HTTP `POST .../chat/completions`:** does not pass these options and still
  rejects `stream: true`. Token deltas never leave the server as SSE on that
  route.

Bundled OpenCode 1.18.4 emits `message.part.delta` on the global event stream
for normal session prompts (same events the UI transcript already consumes).
Throwaway LLM sessions use the same `session.promptAsync` path, so they are
expected to emit the same delta events when the model streams tokens.

Credentials stay in OpenCode. This module does not read `auth.json`, does not
call Anthropic/OpenAI/plugin SDKs, and does not use the `openai` npm package.

No connected provider → `no_provider` (HTTP 400). Upstream failure is never
an empty success. The 502 body includes `{ error, message }`.

## Ownership

The hidden generator agent explicitly describes application-owned tool calls:
it emits `openchamber-tool` JSON for the contact harness to execute and receives
the results on subsequent requests. Native OpenCode tool permissions remain
denied. Capability statements and execution errors must follow the supplied
application tool catalog and actual results.

The Assistant contact harness owns system prompt, OpenChamber transcript,
bubble splitting, and OpenChamber API tools (`assign_session`). Those tools
deliver through contact **cards**, not this completions payload. The gateway
stays a text generator: OpenCode coding tools stay denied.
