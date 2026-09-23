# Small Model

Server-side LLM calls that reuse the user's existing OpenCode provider logins.
Dedicated adapters still read `~/.local/share/opencode/auth.json`. Plugin and
other non-dedicated providers are listed from OpenCode's connected catalog
(`provider.list()` ∩ `config.providers`, same as `loadConnectedCatalog`).
OpenCode uses a "small model" internally
(titles, summaries) but does not expose it through the SDK or plugins — this
module replicates that mechanism as an OpenChamber runtime API.

## Security boundary

Credentials never leave the server process. The client sends only a prompt;
auth resolution, OAuth refresh, and provider dispatch all happen server-side
(either in dedicated adapters or inside the OpenCode runtime for the session
path). Routes live under `/api/*` and are gated by the ui-auth middleware like
every other runtime API.

## Files

- `index.js` — `createSmallModelService(dependencies)` factory. Production
  obtains a single lazy instance from `server/index.js` (`getSmallModelService`)
  and injects it into feature routes, session assist/title/goal, and scheduled
  tasks. Tests may call the factory with a mock `getModelCatalog`. Returns
  `stop()` to remove the lazy temp directory used by the session path (wired
  from `server/index.js` `stop()`).
- `opencode-session.js` — fallback for non-dedicated providers. Lazily prepares
  `mkdtemp('openchamber-smallmodel-')` with a hidden deny-all agent markdown
  (isolation invariant), then calls official `@opencode/client`
  `generate.text({ location?, prompt, model: { id, providerID } })`. No coding
  session / `promptAsync` / `tool.ids` path. Empty text is never success.
- `resolve.js` — model selection, mirroring OpenCode's `getSmallModel` chain:
  0. OpenChamber's own settings override (Settings → Sessions → Small Model):
     when `smallModelUseDefault` is `false`, `smallModelOverride`
     (`provider/model`) outranks everything below. Sanitized in
     `settings-helpers.js` (server), `persistence.ts` (client), and
     `bridge-settings-runtime.ts` (VS Code).
  1. `small_model` from the merged OpenCode config layers (`provider/model`).
  2. Family-priority scan (`gemini-flash` → `gpt-nano` → `claude-haiku`)
     **within the session's provider first** (`preferredProviderID`, like
     OpenCode resolves within the current provider), then keyword tiers on that
     provider's catalog, then the session model, then other authenticated
     providers' catalog families, then keyword+cost default across providers,
     then the four minimal hardcoded candidates.
  3. GitHub Copilot hidden utility models (`gpt-*-nano/mini`) — these never
     appear in the catalog, so they participate as the `gpt-nano` family entry
     and as a final utility fallback.
  4. Session model (`preferredModelID`) when the session provider has auth but
     no small family/keyword match.
  Auth-type constraints for the four dedicated providers: OpenAI OAuth →
  hardcoded codex-small; OpenAI API key → catalog families; Anthropic/Google
  require API keys; Copilot supports auth aliases (`copilot` / `github-copilot`).

  **Default ranking (no explicit config):** candidates are catalog models from
  usable auth entries. Keyword tiers (tokenized id / known family):
  `flash` → `nano` → `haiku` → `mini` → `lite` → `turbo` → `instant` →
  `small` → `chat`. Within a tier: `cost.input` ascending (missing cost last),
  then newer `release_date`.
- Input clamp: the prompt is truncated to the resolved model's catalog
  `limit.context` (minus an output reserve, ~4 chars/token estimate;
  conservative default when the model is not in the catalog). Truncation is
  reported as `inputTruncated: true` in the response.
- `call.js` — dedicated wire formats and per-provider auth for the four
  adapters (replicating OpenCode plugin auth loaders):
  - **GitHub Copilot**: OpenAI-compatible `/chat/completions` on
    `https://api.githubcopilot.com` (or `copilot-api.<enterprise>`) with the
    stored device-OAuth token as the bearer — no token exchange, no expiry.
  - **OpenAI OAuth (ChatGPT plan)**: streaming Responses API on
    `https://chatgpt.com/backend-api/codex/responses` with
    `ChatGPT-Account-Id`; expired tokens are refreshed against
    `auth.openai.com` (single-flight) and written back to `auth.json`.
  - **Anthropic** (`type: api`): `/v1/messages` with `x-api-key`.
  - **Google** (`type: api`): `generateContent` with `x-goog-api-key`.
  - Custom Summary AI mode: OpenAI-compatible `/chat/completions` against the
    user-supplied base URL + token.
  Generic `api.url` chat-completions for arbitrary providers is **not** used
  for dispatch anymore (plugin providers need runtime rewrite); those providers
  take the OpenCode session path instead. The helper remains in `call.js` for
  the dedicated adapters and custom mode.
- `catalog.js` — directory-scoped provider catalog via official
  `@opencode/client` `provider.list` + `model.list`. Model ids are `ModelInfo.id`
  (external generate/session id). `ModelInfo.modelID` is internal and is not
  preferred. v2 `cost` arrays keep the base tier's `input` / `output`. Base
  URL/auth come from the composition root (`buildOpenCodeUrl` /
  `getOpenCodeAuthHeaders`).
  Per-directory short TTL (~30s) with single-flight. OpenCode failure returns
  an **explicit** minimal fallback catalog (OpenAI OAuth / GitHub Copilot /
  Google API / Anthropic API candidates only) — never an authoritative empty
  map. Raw small-model fields kept: `family`, `release_date`, `limit`,
  `cost.input` / `cost.output`, `model.api.url`, provider `name`. Client-safe
  provider catalog projection remains in `opencode/provider-catalog.js` for
  `/api/config/catalog/providers`.
- `routes.js` — `GET /api/small-model` (resolution preview),
  `POST /api/small-model/generate` (`{ prompt, system?, maxOutputTokens?,
  model?, directory? }` → `{ text, providerID, modelID, source }`),
  `POST /api/small-model/test` (custom OpenAI-compatible probe → `{ ok, code? }`),
  and `POST /api/small-model/custom-models` (best-effort `{baseURL}/models`
  suggestions → `{ models }`).
- `custom-api.js` — custom Summary AI probe and model listing. Failure codes
  are `incomplete`, `token` (401/403), `model` (404 / `model_not_found`), or
  `baseURL` (network / non-OpenAI-compatible). Tokens are never logged.

## Dispatch

| Mode / provider | Path |
|---|---|
| Summary AI `custom` | Direct OpenAI-compatible call (`call.js`) |
| Summary AI provider mode (`commit` / `session-title`) | Assistant LLM gateway (`llm/completions.js` `createChatCompletion`: connected-catalog check, then `generate.text`) |
| Other purposes: `openai` / `anthropic` / `google` / `github-copilot` with usable dedicated auth | Direct dedicated adapter (`call.js`) |
| Other purposes: any other usable auth + catalog model (plugin providers, …) | Temporary OpenCode session (`opencode-session.js`) |

Summary AI provider mode never uses the dedicated adapters, the small-model
whitelist, or family-scan fallback. A model that is not in the connected
catalog fails with the gateway's `no_provider` error instead of silently
switching models.

## OpenCode session lifecycle

1. Lazy singleton temp directory under `os.tmpdir()` /
   `openchamber-smallmodel-*` with `.opencode/agent/openchamber-smallmodel.md`
   (`hidden: true`, `permissions: [{ action: "*", resource: "*", effect: deny }]`).
2. `session.create` with title `[small-model] <purpose>`, agent name, and
   `metadata.openchamber.smallModel = { purpose }` (sidebar invisibility also
   depends on a parallel filter lane for that marker).
3. Immediate `session.update({ time: { archived } })` (same pattern as
   assistants / scheduled tasks) so ordinary lists never flash the session.
4. `session.promptAsync` with `{ model: { providerID, modelID }, agent, system?,
   parts: [{ type: 'text', text, synthetic: false }] }`.
5. Poll `session.status` + `session.messages` until idle assistant completed
   (budget `SESSION_SETTLE_TIMEOUT_MS` = 60s). Network / timeout / empty text
   all throw with context — never an empty success.
6. `finally`: best-effort `session.delete`. Delete failure is logged and does
   not erase a successful text result.
7. Server `stop()` calls `smallModelServiceInstance.stop()` to `rm` the temp
   directory.

### Skills / clean context boundary

OpenCode always loads skill *guidance* via `SkillInstructions.load` into the
system prompt (`packages/core/src/session/context.ts`). Availability is filtered
by `Permission.evaluate("skill", skill.id, agent.permissions)` — a deny-all
`action: "*"` rule therefore excludes every skill from the available list, so
the guidance renders as "No skills are currently available." Skill **body**
content is only injected when the skill tool runs; deny-all also blocks that
tool. There is no separate agent/directory flag to disable skill guidance
beyond permissions. Global `~/.agents/skills` may still be *discovered* by the
OpenCode instance, but they are not listed or loadable under this agent.
Project-level skills are absent because the temp directory has none.

## Registration

`server/index.js` creates one lazy `getSmallModelService` and injects
`{ buildOpenCodeUrl, getOpenCodeAuthHeaders }` into the factory (and into
session assist/title/goal, scheduled tasks, and `createFeatureRoutesRuntime`).
Feature routes no longer import `small-model/index.js` top-level exports
directly.

## Summary AI settings

Commit-message generation and session-title refresh pass `purpose: 'commit'`
or `purpose: 'session-title'` to `generateSmallModelText`. Settings → Summary
AI can select an OpenCode provider/model from the same catalog and picker as
Assistants (`useScopedProvidersQuery(null)` + `ModelSelector`) or a custom
OpenAI-compatible `baseURL`, model ID, and API token. Custom mode stores the
model id in `summaryCustomModelID` (legacy `summaryModelID` is still read when
that field is absent). Custom mode is enabled only when base URL, model ID,
and API token are all present. A custom token stays in the server settings
file; settings read responses expose only `hasSummaryCustomAPIToken`. Settings
can probe the custom API (`POST /api/small-model/test`) and load model
suggestions from `{baseURL}/models` without blocking free-form entry.

`summaryCommitPrompt` and `summarySessionTitlePrompt` replace the respective
call's system prompt when non-empty. With no persisted provider choice (the
picker shows "OpenCode default model"), summary calls use OpenCode's
`model.default`. No default model is an explicit 404, not a fallback guess.
The chosen or default model stays authoritative when the active session uses
another provider.

## Known limitations

- OpenCode's free models (`opencode/big-pickle`, `*-free`) work without a
  token only through OpenCode's own server — direct calls are rejected, and
  piggybacking on their subsidized infra is out of bounds by design. Every
  resolution step therefore requires a usable auth entry for the provider:
  a session on an unauthenticated `opencode` provider falls through to the
  global scan (or a clean 404 on a vanilla setup with no logins).

- Anthropic OAuth (Claude Pro/Max) entries are not supported on the dedicated
  adapter — OpenCode itself keeps those outside `auth.json` in this generation;
  only `type: api` keys work for Anthropic direct calls. Plugin / other auth
  shapes that OpenCode can already run may still succeed via the session path.
- Responses from the codex backend are collected from the SSE stream; the
  endpoint itself is non-streaming by design (small utility calls).
- The server never requests models.dev. When OpenCode is down, only the four
  minimal hardcoded candidates remain available for resolution; session-path
  generation still requires a live OpenCode runtime.
