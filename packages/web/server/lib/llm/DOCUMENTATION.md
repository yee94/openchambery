# OpenChamber LLM Gateway

OpenAI-shaped Chat Completions for the in-app Assistant contact. This is the
only model path the Assistant harness (`pi-agent-core` `streamFn`) talks to.

## Contract

- `GET /api/openchamber/llm/models` — connected `{providerID, modelID}` catalog
  from OpenCode `GET /provider` (`connected`) plus `GET /config/providers`.
  Plugin adapter formats stay inside OpenCode; this route does not parse them.
- `POST /api/openchamber/llm/chat/completions` — `{ model, messages, stream?,
  providerID?, modelID? }` → OpenAI `chat.completion` JSON.
  This gateway is **non-streaming**. Bundled OpenCode 1.18.4 generate
  (`POST /generate` when present, otherwise throwaway `session.promptAsync`
  plus idle wait) returns a full assistant turn. `stream: true` is rejected with
  `validation_error` (HTTP 400). Do not emit fake SSE after the fact.
  The contact UI waits for the completed turn; it does not typewrite tokens.

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
   are forwarded on `promptAsync` so vision models can see images. Non-image
   text files are also inlined into the flattened prompt. Wait for idle via
   `session.status` + `session.messages`, then delete the session. This is a
   text generator only — never the contact transcript and never a coding
   SessionPrompt loop. Upstream `info.error.message` is forwarded on 502.

Credentials stay in OpenCode. This module does not read `auth.json`, does not
call Anthropic/OpenAI/plugin SDKs, and does not use the `openai` npm package.

No connected provider → `no_provider` (HTTP 400). Upstream failure is never
an empty success. The 502 body includes `{ error, message }`.

## Ownership

The Assistant contact harness owns system prompt, OpenChamber transcript,
bubble splitting, and OpenChamber API tools (`assign_session`). Those tools
deliver through contact **cards**, not this completions payload. The gateway
stays a text generator: OpenCode coding tools stay denied.
