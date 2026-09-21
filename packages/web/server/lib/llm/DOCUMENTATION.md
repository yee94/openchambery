# OpenChamber LLM Gateway

OpenAI-shaped Chat Completions for the in-app Assistant contact. This is the
only model path the Assistant harness (`pi-agent-core` `streamFn`) talks to.

## Contract

- `GET /api/openchamber/llm/models` — available `{providerID, modelID}` catalog
  from official `@opencode-ai/client` `provider.list` + `model.list`
  (`{ location, data }`). `ModelInfo.id` is the external modelID used in
  generate/session refs (`ModelInfo.modelID` is a separate internal field).
  Vision is `capabilities.input` containing `image`.
- `POST /api/openchamber/llm/chat/completions` — `{ model, messages, stream?,
  providerID?, modelID? }` → OpenAI `chat.completion` JSON.
  This **public** gateway is **non-streaming**. `stream: true` is rejected with
  `validation_error` (HTTP 400). Do not emit fake SSE after the fact on this
  route. The contact UI may stream later via a **server-internal** path only.

`model` may be `providerID/modelID` or a bare `modelID` paired with `providerID`.

## Internals (official `@opencode-ai/client`)

Credentials stay in OpenCode. This module does not read `auth.json`, does not
call Anthropic/OpenAI/plugin SDKs, and does not use the `openai` npm package.

### Text path (no vision image bytes)

`client.generate.text({ location?, prompt, model: { id, providerID, variant? } },
{ signal })` → `{ text }`. No session. System text is prepended into `prompt`.
`onTextDelta` is skipped honestly (no fake typewriter).

### Attachment / vision path

When the catalog marks the model vision-capable and the request includes image
data-URL file parts:

1. Ensure the throwaway temp directory agent markdown (`openchamber-llm`,
   permissions array ending in `action:* resource:* effect:deny`).
2. `agent.get({ agentID: 'openchamber-llm', location })` and require the **final**
   permissions rule to be deny-all. Failure → `llm_attachment_generation_unavailable`
   **before** any `session.prompt`. Title is never treated as permission isolation.
3. `session.create({ location, agent, model: { id, providerID } })` (bare session id).
4. Optional `session.instructions.entry.put` for the system prompt.
5. Subscribe for `session.text.delta` (`data.sessionID` / `assistantMessageID` /
   `ordinal` / `delta`) before prompt; unsubscribe in `finally`.
6. `session.prompt({ sessionID, text, files: [{ uri, name? }], delivery })`.
7. `session.wait` then `message.list({ order: 'desc' })`; verify newest assistant
   `finish` / `error`; extract text content.
8. On timeout/abort: `session.interrupt({ continue: false })` and always
   `session.remove` in `finally`.

Non-vision models keep the `[image: …]` description strategy and never forward
image bytes. Data URLs are strictly validated; a single attachment is capped at
20 MiB (plus existing inline text-file limits). An external/temp workspace that
OpenCode cannot see fails explicitly (`llm_attachment_generation_unavailable`).

There is no `/generate` probe, no `tool.ids` deny map, and no `promptAsync` path.

### Internal token callback (in-process only)

`generateOpenCodeText` / `createChatCompletion` accept optional
`onTextDelta(text: string)` and `globalEventHub`.

- **Attachment session path:** real `session.text.delta` tokens for this session.
- **`generate.text` path:** cannot emit live deltas — skip `onTextDelta`.
- **HTTP `POST .../chat/completions`:** does not pass these options and still
  rejects `stream: true`.

No connected provider → `no_provider` (HTTP 400). Upstream failure is never
an empty success. The 502 body includes `{ error, message }`.

## Ownership

The Assistant contact harness owns system prompt, OpenChamber transcript,
bubble splitting, and OpenChamber API tools (`assign_session`). Those tools
deliver through contact **cards**, not this completions payload. The gateway
stays a text generator: OpenCode coding tools stay denied on the attachment path
via the verified agent permissions ruleset.
