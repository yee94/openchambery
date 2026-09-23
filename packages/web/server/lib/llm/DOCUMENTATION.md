# OpenChamber LLM Gateway

OpenAI-shaped Chat Completions for the in-app Assistant contact. This is the
only model path the Assistant harness (`pi-agent-core` `streamFn`) talks to.

## Contract

- `GET /api/openchamber/llm/models` — available `{providerID, modelID}` catalog
  from official `@opencode/client` `provider.list` + `model.list`
  (`{ location, data }`). `ModelInfo.id` is the external modelID used in
  generate/session refs (`ModelInfo.modelID` is a separate internal field).
  Vision prefers `capabilities.input.image === true` (SDK object shape), then
  v2 list `capabilities.input` containing `"image"`, then legacy
  modalities/input/attachment. Catalog loads use a bounded AbortSignal
  (default 8s) so a pending provider call cannot stall a contact lane.
- `POST /api/openchamber/llm/chat/completions` — `{ model, messages, stream?,
  providerID?, modelID?, variant? }` → OpenAI `chat.completion` JSON.
  This **public** gateway is **non-streaming**. `stream: true` is rejected with
  `validation_error` (HTTP 400). Do not emit fake SSE after the fact on this
  route. The contact UI may stream later via a **server-internal** path only.

`model` may be `providerID/modelID` or a bare `modelID` paired with `providerID`.

`variant` is an optional OpenCode model variant string. Null, omitted, or empty
values preserve the provider default. Other types fail validation before a model
call. A selected variant is forwarded unchanged on the throwaway session's
`model` ref (both paths). OpenCode owns provider-specific variant
semantics. Variant selection changes inference configuration only; completion
output continues to include text parts and keeps reasoning parts private.

## Internals (official `@opencode/client`)

Credentials stay in OpenCode. This module does not read `auth.json`, does not
call Anthropic/OpenAI/plugin SDKs, and does not use the `openai` npm package.

### Text path (no vision image bytes)

`session.generate` inside a throwaway session owned by the hidden deny-all
`openchamber-text` agent (same temp root, same deny-all verification and
`session.create` / `session.remove` lifecycle as the attachment path below):

1. Ensure `.opencode/agent/openchamber-text.md` and verify its final
   permission rule is deny-all before creating the session.
2. `session.create({ location, agent: 'openchamber-text', model, metadata })`.
3. `session.generate({ sessionID, prompt })` → `{ text }`. One model call with
   the session's provider context, no tool loop, no messages written. System
   text is prepended into `prompt`.
4. Always `session.remove` in `finally` (interrupt first on abort/timeout).

`generate.text` (sessionless) is not used: session-scoped providers such as
OpenCode Go reject calls without a session (`x-opencode-session`).
`onTextDelta` is skipped honestly (no fake typewriter).

OpenCode loads a fresh location's config lazily, so `agent.get` can report the
agent as missing on the first read. Deny-all verification polls within a
bounded window (5s) before failing.

### Attachment / vision path

When the catalog marks the model vision-capable and the request includes image
data-URL file parts:

1. Ensure the throwaway temp directory agent markdown (`openchamber-llm`,
   permissions array ending in `action:* resource:* effect:deny`).
2. `agent.get({ agentID: 'openchamber-llm', location })` and require the **final**
   permissions rule to be deny-all. Failure → `llm_attachment_generation_unavailable`
   **before** any `session.prompt`. Title is never treated as permission isolation.
3. `session.create({ location, agent, model: { id, providerID, variant? },
   metadata: { openchamber: { llm: { purpose: 'chat-completions' } } } })`
   (bare session id). Host `persistSessionMetadata` then commits the same
   isolation patch; `onSystemSessionPersisted` drops the throwaway session
   from the sidebar index. Create-time `metadata` is a hint only.
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

`ensureLlmTempDirectory` keeps one process-wide throwaway root (`openchamber-llm-…`).
Concurrent first callers share a single `mkdtemp` inflight; every caller still
writes/refreshes `.opencode/agent/<name>.md` after settle so a mid-flight ensure
cannot skip a newer agent body. Concurrent warm refreshes serialize through one
write chain (last committed body wins; no interleaved partial writes).
`stopLlmTempDirectory` clears the singleton for shutdown/tests.

There is no `/generate` probe, no `tool.ids` deny map, and no `promptAsync` path.
There is no `config.providers` catalog path.

### Internal token callback (in-process only)

`generateOpenCodeText` / `createChatCompletion` accept optional
`onTextDelta(text: string)` and `globalEventHub`.

- **Attachment session path:** real `session.text.delta` tokens for this session.
- **`session.generate` text path:** cannot emit live deltas — skip `onTextDelta`.
- **HTTP `POST .../chat/completions`:** does not pass these options and still
  rejects `stream: true`.

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
stays a text generator: OpenCode coding tools stay denied on both paths via the
verified agent permissions ruleset.

The gateway is also the single OpenCode-backed path for server utility calls
(`small-model`: commit messages, session titles, goal audits, scheduled-task
distill, TTS summaries, PR descriptions). No server module calls provider APIs
directly with OpenCode credentials.

Internal completion/generate calls accept an optional AbortSignal from the
contact continuation. It is combined with the generator deadline and passed to
upstream requests. Cancellation still runs throwaway-session cleanup
(`interrupt` + `remove`); it must not turn a late model response into a new
tool operation.
