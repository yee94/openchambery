# Quota Module Documentation

## Purpose
This module fetches quota and usage signals for supported providers in the web server runtime.

## Entrypoints and structure
- `packages/web/server/lib/quota/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/quota/routes.js`: Express route registration for quota endpoints.
- `packages/web/server/lib/quota/providers/index.js`: provider registry, configured-provider list, and provider dispatcher.
- `packages/web/server/lib/quota/providers/google/`: Google-specific auth, API, and transform modules.
- `packages/web/server/lib/quota/utils/`: shared auth, transform, and formatting helpers.

## Supported provider IDs (dispatcher)

These provider IDs are currently dispatchable via `fetchQuotaForProvider(providerId)` in `packages/web/server/lib/quota/providers/index.js`.

| Provider ID | Display name | Module | Auth aliases/keys |
| --- | --- | --- | --- |
| `claude` | Claude | `providers/claude.js` | `anthropic`, `claude` |
| `codex` | Codex | `providers/codex.js` | `openai`, `codex`, `chatgpt` |
| `cursor` | Cursor | `providers/cursor.js` | Environment/token files, OpenChamber-managed credentials, or explicit one-time Cursor import |
| `google` | Google | `providers/google/index.js` | `google`, `google.oauth`, Antigravity accounts file |
| `github-copilot` | GitHub Copilot | `providers/copilot.js` | `github-copilot`, `copilot` |
| `github-copilot-addon` | GitHub Copilot Add-on | `providers/copilot.js` | `github-copilot`, `copilot` |
| `kimi-for-coding` | Kimi for Coding | `providers/kimi.js` | `kimi-for-coding`, `kimi` |
| `nano-gpt` | NanoGPT | `providers/nanogpt.js` | `nano-gpt`, `nanogpt`, `nano_gpt` |
| `openrouter` | OpenRouter | `providers/openrouter.js` | `openrouter` |
| `zai-coding-plan` | z.ai | `providers/zai.js` | `zai-coding-plan`, `zai`, `z.ai` |
| `zhipuai-coding-plan` | Zhipu AI Coding Plan | `providers/zhipuai-coding-plan.js` | `zhipuai-coding-plan`, `zhipuai`, `zhipu` |
| `minimax-coding-plan` | MiniMax Coding Plan (minimax.io) | `providers/minimax-coding-plan.js` / `providers/minimax-shared.js` | `minimax-coding-plan` |
| `minimax-cn-coding-plan` | MiniMax Coding Plan (minimaxi.com) | `providers/minimax-cn-coding-plan.js` / `providers/minimax-shared.js` | `minimax-cn-coding-plan` |
| `ollama-cloud` | Ollama Cloud | `providers/ollama-cloud.js` | Manual cookie stored under `~/.config/openchamber/quota/` |
| `wafer` | Wafer.ai | `providers/wafer.js` | `wafer`, `wafer-ai`, `wafer_ai`, `wafer.ai` |
| `opencode-go` | OpenCode Go | `providers/opencode-go.js` | Manual workspace ID and auth cookie stored under `~/.config/openchamber/quota/` |
| `xai` | Grok | `providers/xai.js` | Grok Build CLI login state (`~/.grok/auth.json`; override via `GROK_HOME`, `GROK_AUTH_PATH`, or `OPENCHAMBER_GROK_AUTH_PATH`) |

## Magpie aggregate source

`magpie.js` owns `GET /api/quota/magpie?directory=...`; `refresh=1` requests a vendor refresh.
The host reads the active OpenCode service's location-scoped `config.get()` documents and selected
credentials. Configured `providers.*.settings.baseURL` values are candidates, regardless of their names
or ports. GET of the normalized versioned base must identify `name: magpie` and advertise
`/v1/magpie/quotas`. HTTP(S) proxy prefixes are retained; redirects and credential-bearing URLs are refused.
Only the candidate's own configured authorization/API-key headers or selected API credential are sent.
No port scan, local OpenCode config fallback, or persistent credential cache is used.

`magpie-local.js` also reads same-host Magpie address hints: `MAGPIE_ADDR`, and `port` in
`$XDG_CONFIG_HOME/magpie/settings.json` / `~/.config/magpie/settings.json`. Magpie's documented default
port is tried only when its configuration directory exists. Every hint still passes the identity probe;
there is no port scan, credential-file access, or configuration write. Local discovery works even if
OpenCode connection discovery fails. Partial discovery is marked `incomplete` so UI reconciliation keeps
unreported previous sources instead of treating them as authoritatively removed.

Usage shows connection status by default; the optional address form is collapsed under “Connect another
Magpie” and stacks its label, input and action in narrow sidebars. No manual configuration is required
when Magpie runs beside the OpenChamber server. This does not discover a Magpie on the phone/browser's
machine when connected to a different server.

Settings → Usage also accepts `magpieUsageUrl`, an optional explicit gateway URL. Its optional remote
key comes from the host environment's `OPENCHAMBER_MAGPIE_API_KEY`; no key is stored in UI settings.
Magpie must allow quota access for remote keys. An identity/permission failure remains visible.

Opening uses `/v1/magpie/quotas?kept=1`; refresh uses `/v1/magpie/quotas`. A failed refresh may fall back
to the kept snapshot with an explicit error/stale marker, never an invented fresh empty success.
Authorization failures do not use the fallback and discard previously displayed scope data.
Discovery runs at most four candidates concurrently and deduplicates URL plus credential scope within
one request. Every gateway yields one aggregate read, not one read per account/provider.

Each upstream provider gets a namespaced `magpie:<source>:<provider>` result, independent of built-ins.
`usage.accounts` retains separate account windows, errors and reading timestamps. `usage.windows`
is the account-keyed projection for existing header/mobile/tray consumers. Compact surfaces display
`window.label` rather than the account-bearing key; account detail remains on the full Usage page.
Opening a usage menu checks the full refresh timestamp, not whether any results exist: a discovered
Magpie snapshot must not suppress the initial built-in provider fetch. Percentages, balance
labels, unlimited windows and absolute reset timestamps are preserved. Window duration remains unknown
and pace prediction is disabled rather than inferred. Upstream error bodies are never returned.

The UI shares Query flights keyed by transport, directory, manual URL and refresh mode. Directory/runtime
switches fence late completions. Failed sources retain previous readings with an error; complete empty
sources remove their rows. `magpieHiddenProviders` preserves opt-outs while newly discovered providers
are visible by default. Web/Electron/hosted-mobile/Capacitor use the host route; VS Code invokes the same
module through `api:quota:magpie` and its current manager/credential resolver.

## Internal-only provider module
- `providers/openai.js` exists for logic parity/reuse but is intentionally not registered for dispatcher ID routing.

## Response contract
Provider credentials are read asynchronously from the current OpenCode service via
`opencode/auth.js`; only the selected credential is used. Account switching and
logout are observed on the next request, without file fallback or persisted secret
cache. Credential-list transport/auth/schema failure rejects the configured-provider
list instead of returning an authoritative empty list; per-provider quota requests
return `ok: false` with a sanitized error. VS Code uses the same credential adapter.
OpenChamber-owned quota cookies and Grok/Antigravity-specific stores retain their
separate explicit sources; they are not legacy OpenCode `auth.json` fallbacks.

All providers should return results via shared helpers to preserve API shape:
- Required fields: `providerId`, `providerName`, `ok`, `configured`, `usage`, `fetchedAt`
- Optional field: `error`
- Unsupported provider requests should return `ok: false`, `configured: false`, `error: Unsupported provider`

Provider modules must export `providerId`, `providerName`, `aliases`, `isConfigured(auth?)`, and `fetchQuota()`.
`fetchQuota()` should return a quota result with `usage.windows` keyed by window name (for example `5h`, `7d`, `daily`) and optional provider-specific `usage.models` data.

OpenCode Go, Ollama Cloud, and Cursor credentials are explicitly managed through Settings. The server validates credentials before atomic `0600` writes and never returns secrets through its API. OpenChamber never scans browser cookie stores or automatically reads Cursor storage; Cursor import is an explicit one-time user action and never modifies Cursor's database.

## Add a new provider (quick steps)
1. Choose module shape based on complexity:
   - Simple providers: create `packages/web/server/lib/quota/providers/<provider>.js`.
   - Complex providers (multi-source auth, multiple API calls, non-trivial transforms): create `packages/web/server/lib/quota/providers/<provider>/` with split modules like Google (`index.js`, `auth.js`, `api.js`, `transforms.js`).
2. Export `providerId`, `providerName`, `aliases`, `isConfigured`, and `fetchQuota`.
3. Use shared helpers from `packages/web/server/lib/quota/utils/index.js` (`buildResult`, `toUsageWindow`, auth/conversion helpers) to keep payload shape consistent.
4. Register the provider in `packages/web/server/lib/quota/providers/index.js`.
5. If needed for direct use, export a named fetcher from `packages/web/server/lib/quota/providers/index.js` and `packages/web/server/lib/quota/index.js`.
6. Update this file with the new provider ID, module path, and alias/auth details.
7. Validate with `bun run type-check`, `bun run lint`, and `bun run build`.

## MiniMax M3 / Token Plan migration

In 2025/2026 MiniMax rebranded "Coding Plan" to "Token Plan" alongside the M3 model release. The API underwent breaking changes:

- **Endpoint fallback**: The provider tries `/v1/token_plan/remains` (M3) first, falling back to legacy `/v1/api/openplatform/coding_plan/remains`.
- **Field semantics**: On the `token_plan/remains` endpoint, `current_interval_usage_count` returns **remaining** quota (not consumed). The provider computes `used = total - remaining` for this endpoint. The legacy `coding_plan/remains` endpoint retains the old semantics (`usage_count = consumed`).
- **Percentage-based plans**: Legacy Coding Plan accounts return `current_interval_total_count: 0` but include `current_interval_remaining_percent`. The provider prefers this field when count fields are absent.
- **model_remains array**: Now contains entries for multiple model categories (chat, speech, video, image). The provider selects the chat-model entry by matching `MiniMax-M*`, then `general`/`chat`/`text` by name, then any entry with a remaining percent.
- **Window status**: The `current_interval_status` and `current_weekly_status` fields indicate whether a window is active. Status `3` means the window is not applicable for the current plan tier (e.g. legacy plans without weekly limits). The provider omits inactive windows.

## Notes for contributors
- Keep provider IDs stable; clients use them directly.
- Avoid adding alias-based dispatch in `fetchQuotaForProvider`; dispatch currently expects exact provider IDs.
- Keep Google behavior changes isolated and review `providers/google/*` together.
