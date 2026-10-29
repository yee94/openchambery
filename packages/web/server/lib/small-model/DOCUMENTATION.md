# Small Model

Server-side utility LLM calls (commit messages, session titles, goal audits,
scheduled-task distill, TTS summaries, PR descriptions) routed through the
user's connected OpenCode providers. OpenCode uses a "small model" internally
(titles, summaries) but does not expose it through the SDK or plugins — this
module replicates the selection as an Yuri runtime API and sends every
OpenCode-backed call through the Assistant LLM gateway
(`llm/completions.js` `createChatCompletion`).

## Security boundary

Credentials never leave OpenCode. This module does not read `auth.json`, does
not refresh OAuth tokens, and does not call provider APIs directly. The client
sends only a prompt; model resolution happens server-side and generation runs
inside the OpenCode runtime. The only direct HTTP call is the user-configured
custom Summary AI endpoint, with the token the user saved for it. Routes live
under `/api/*` and are gated by the ui-auth middleware like every other
runtime API.

## Files

- `index.js` — `createSmallModelService(dependencies)` factory. Production
  obtains a single lazy instance from `server/index.js` (`getSmallModelService`)
  and injects it into feature routes, session assist/title/goal, and scheduled
  tasks. Tests may inject `getModelCatalog`, `openCodeClientFactory`, and
  `createChatCompletion`. The gateway performs no temporary Session creation.
- `resolve.js` — model selection over the connected catalog only, mirroring
  OpenCode's `getSmallModel` chain:
  0. Yuri's own settings override (Settings → Sessions → Small Model):
     when `smallModelUseDefault` is `false`, `smallModelOverride`
     (`provider/model`) outranks everything below. Sanitized in
     `settings-helpers.js` (server), `persistence.ts` (client), and
     `bridge-settings-runtime.ts` (VS Code).
  1. `small_model` from the merged OpenCode config layers (`provider/model`).
  2. When the session's provider (`preferredProviderID`) is in the connected
     catalog: family-priority scan (`gemini-flash` → `gpt-nano` →
     `claude-haiku`), then keyword tiers on that provider, then the session
     model itself.
  3. Otherwise the other connected providers: family scan, then keyword+cost
     default across providers.
  4. Nothing connected → `null` (routes answer 404).

  **Keyword ranking:** tokenized id / known family tiers `flash` → `nano` →
  `haiku` → `mini` → `lite` → `turbo` → `instant` → `small` → `chat`. Within a
  tier: `cost.input` ascending (missing cost last), then newer `release_date`.
- Input clamp: the prompt is truncated to the resolved model's catalog
  `limit.context` (minus an output reserve, ~4 chars/token estimate;
  conservative default when the model has no limit or for the custom API).
  Truncation is reported as `inputTruncated: true` in the response.
- `catalog.js` — directory-scoped provider catalog via official
  `@opencode/client` `provider.list` + `model.list`. Model ids are `ModelInfo.id`
  (external generate/session id). `ModelInfo.modelID` is internal and is not
  preferred. v2 `cost` arrays keep the base tier's `input` / `output`. Base
  URL/auth come from the composition root (`buildOpenCodeUrl` /
  `getOpenCodeAuthHeaders`); the client's custom `fetch` must forward the
  `init` argument (headers, method, body) or OpenCode answers 401.
  Per-directory short TTL (~30s) with single-flight. OpenCode failure rejects
  with `statusCode: 502` and is not cached — never a substitute or empty
  catalog. Raw small-model fields kept: `family`, `release_date`, `limit`,
  `cost.input` / `cost.output`, `model.api.url`, provider `name`. Client-safe
  provider catalog projection remains in `opencode/provider-catalog.js` for
  `/api/config/catalog/providers`.
- `routes.js` — `GET /api/small-model` (resolution preview; query
  `directory`, `providerID`, `modelID`),
  `POST /api/small-model/generate` (`{ prompt, system?, maxOutputTokens?,
  model?, directory?, preferredProviderID?, preferredModelID?,
  restrictToPreferredProvider?, purpose? }` → `{ text, providerID, modelID,
  source }`), `POST /api/small-model/test` (Summary AI connection probe →
  `{ ok, code? }`), and `POST /api/small-model/custom-models` (best-effort
  `{baseURL}/models` suggestions → `{ models }`).
- `custom-api.js` — custom Summary AI generation
  (`generateCustomSummaryText`: OpenAI-compatible `/chat/completions`), probe,
  and model listing. Probe failure codes are `incomplete`, `token` (401/403),
  `model` (404 / `model_not_found`), or `baseURL` (network /
  non-OpenAI-compatible). Reasoning-only or empty replies are errors, never
  blank success. Tokens are never logged.

## Dispatch

| Mode / purpose | Path |
|---|---|
| Summary AI `custom` | User's OpenAI-compatible endpoint (`custom-api.js`) |
| Summary AI provider mode (`commit` / `session-title`) | Saved model, else OpenCode `model.default` → LLM gateway |
| Every other purpose | `resolve.js` over the connected catalog → LLM gateway |

The LLM gateway checks the model against the connected catalog (`no_provider`
otherwise), then uses the built-in clean-inference plugin over authenticated RPC
to the external OpenCode service (see `llm/DOCUMENTATION.md`). No Session API,
agent prompt, Skills, session history or tool loop is involved. Output-token
limits are forwarded. Unsupported provider/authentication adapters fail explicitly
instead of falling back to the previous session.generate path.
`restrictToPreferredProvider` forbids resolution from switching away from the
session's provider unless the model came from an explicit choice (settings
override, OpenCode config, or request `model`).

Summary AI provider mode never uses small-model resolution. A saved model that
is not in the connected catalog fails with the gateway's `no_provider` error
instead of silently switching models.

### Skills / clean context boundary

Only the explicit utility system/prompt messages are sent. OpenCode may discover
its global configuration/plugins to resolve the selected model, but neither skill
guidance nor bodies, AGENTS.md, agent instructions or Session history are part of
the inference input. Clean inference does not use the Session context builder.

## Registration

`server/index.js` creates one lazy `getSmallModelService` and injects
`{ buildOpenCodeUrl, getOpenCodeAuthHeaders, persistSessionMetadata,
onSystemSessionPersisted }` into the factory (and the service into session
assist/title/goal, scheduled tasks, and `createFeatureRoutesRuntime`). Server
`stop()` calls `stopLlmBridgeDirectory()` to remove the isolated plugin directory.

## Summary AI settings

Commit-message generation and session-title refresh pass `purpose: 'commit'`
or `purpose: 'session-title'` to `generateSmallModelText`. Settings → Summary
AI selects an OpenCode provider/model with the shared `ModelSelector` and the
same connected provider list as the chat model picker and Settings → Defaults
(`useConfigStore` providers; no allowlist), or a custom OpenAI-compatible
`baseURL`, model ID, and API token. Custom mode stores the model id in
`summaryCustomModelID` (legacy `summaryModelID` is still read when that field
is absent). Custom mode is enabled only when base URL, model ID, and API token
are all present. A custom token stays in the server settings file; settings
read responses expose only `hasSummaryCustomAPIToken`. Settings can probe
either mode (`POST /api/small-model/test`) and load custom model suggestions from
`{baseURL}/models` without blocking free-form entry.

The test button uses the current form without saving it. `{ mode: 'provider',
providerID, modelID }` probes the exact model through the same LLM gateway;
empty IDs use OpenCode's default, never persisted Summary AI or small-model
overrides. Success requires non-empty generated text. Provider failures return
bounded codes (`no_provider`, `model`, `empty_response`, `generation_failed`)
and a credential-redacted `message` with the provider's failure reason. Custom
probe failures likewise include a redacted message and HTTP status when available.
The UI retains the reason below the test button until the next test; it is not
limited to a transient toast. Requests without `mode: 'provider'`
retain the custom API probe contract. All shared UI runtimes use runtimeFetch
against this authenticated Host route.

Summary generation failures (session titles and commit summaries) emit
`console.error('[small-model] summary generation failed:', ...)` with purpose,
provider/model, status, error code, and redacted provider message. Prompt and
response payloads are not logged. `error-details.js` owns bounded error text
and credential redaction for diagnostics and connection-test responses.

`summaryCommitPrompt` and `summarySessionTitlePrompt` replace the respective
call's system prompt when non-empty. With no persisted provider choice (the
picker shows "OpenCode default model"), summary calls use OpenCode's
`model.default`. No default model is an explicit 404, not a fallback guess.
The chosen or default model stays authoritative when the active session uses
another provider.

## Known limitations

- Provider behavior is OpenCode's: whatever fails in a normal OpenCode session
  fails here with the same upstream error (for example OpenCode's free
  `opencode` tier rejecting non-session utility use, a plugin provider
  returning an unexpected status, or an invalid provider key).
- The first call after server start (or after the temp root is recreated)
  waits for OpenCode to load the fresh location's config; agent verification
  polls up to 5s, so cold calls take noticeably longer than warm ones.
- `session.generate` returns a full reply; utility calls have no streaming.
