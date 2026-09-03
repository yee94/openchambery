# OpenChamber LLM Gateway

OpenAI-shaped Chat Completions for the in-app Assistant contact. This is the
only model path the Assistant harness (`pi-agent-core` `streamFn`) talks to.

## Contract

- `GET /api/openchamber/llm/models` — connected `{providerID, modelID}` catalog
  from OpenCode `GET /provider` (`connected`) plus `GET /config/providers`.
  Plugin adapter formats stay inside OpenCode; this route does not parse them.
- `POST /api/openchamber/llm/chat/completions` — `{ model, messages, stream?,
  providerID?, modelID? }` → OpenAI `chat.completion` (or SSE chunks when
  `stream: true`).

`model` may be `providerID/modelID` or a bare `modelID` paired with `providerID`.

## Internals (verified on bundled `@opencode-ai/sdk` 1.18.4)

The 1.18.4 client exposes `GET /provider`, `GET /config/providers`, and
`session.prompt` / `session.promptAsync`. It does **not** expose
`POST /api/generate` or any other sessionless generate method.

1. Probe `POST /generate` (and SDK `generate` if present). Use it only when
   the running OpenCode actually serves it.
2. Otherwise create a throwaway archived OpenCode session, deny every tool
   (`client.tool.ids()` → `{ [id]: false }`), send our messages as
   `system` + user text via `session.prompt`, read assistant text, delete
   the session. This is a text generator only — never the contact transcript
   and never a coding SessionPrompt loop.

Credentials stay in OpenCode. This module does not read `auth.json`, does not
call Anthropic/OpenAI/plugin SDKs, and does not use the `openai` npm package.

No connected provider → `no_provider` (HTTP 400). Upstream failure is never
an empty success.

## Ownership

The Assistant contact harness owns system prompt, OpenChamber transcript, and
bubble splitting. Next-slice OpenChamber tools (assign / watch / summon) must
deliver through contact **cards**, not this completions payload.
