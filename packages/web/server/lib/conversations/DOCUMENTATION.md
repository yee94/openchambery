# Conversations Module

## Purpose
Server-owned conversation orchestration for OpenChamber. Provides an idempotent create-session-and-first-prompt workflow using `session.create` + `session.prompt` (`delivery=steer`) through `@opencode-ai/sdk/v2` directory-scoped client, exposed as `POST /api/openchamber/conversations`. Host does not cache message body.

## Scope
- This module is OpenChamber feature logic, intentionally separate from OpenCode proxy/runtime internals.
- Registered in `feature-routes-runtime.js` before the generic OpenCode proxy.
- JSON request bodies are parsed by the explicit OpenChamber route allowlist in `core-routes.js`; conversation payloads allow up to 50 MB so data-URL attachments reach validation and the OpenCode SDK.
- Only accepts `input.type === 'prompt'`; shell/slash commands use the existing SDK sequence.
- `prompt` + `delivery=steer` returns an inbox item immediately (does not wait for model completion).

## Operation Idempotency

The endpoint is idempotent by `messageID`:
- **Same `messageID` + same payload** → reuses in-flight promise (concurrent dedup) or cached completed result (5-min TTL).
- **Same `messageID` + different payload** → returns 409 conflict.
- **All inflight** (at capacity, 500 max entries) → returns 503 unavailable. Only completed entries are evicted.
- **Client disconnect** does NOT abort server operation. The operation completes in the registry; reconnection with same payload retrieves the cached result.

The registry (`registry.js`) is an in-memory map per Express app instance with:
- 500 max entries (evicts oldest completed when full)
- 5-min TTL on completed entries (lazy cleanup on each `run()`)
- `fingerprint()` produces a stable, key-sorted canonical string of sanitized input (including parts order)

## Authentication
Global `/api/*` auth is enforced by `core-routes.js` (`app.use('/api', requireApiAuth)`) before feature routes are registered. This module does not add redundant auth middleware.

## Readiness
The service calls `waitForOpenCodeReady(6000, 75)` (6s, matching proxy gate `READINESS_HOLD_MAX_MS`) before creating the SDK client. If readiness times out, the endpoint returns a structured create-phase failure.

## Files
- `packages/web/server/lib/conversations/validation.js`
  - Request validation and sanitization with strict whitelist
  - Required: `input.type='prompt'`, `directory`, `messageID`, `model` (providerID/modelID), `parts` (non-empty array)
  - Optional: `title`, `parentID`, `agent`, `variant`, `metadata`
  - **Rejected**: `delivery`, `format`, unknown top-level keys (whitelist enforcement)
  - Part types: `text` (requires non-empty `text`), `file` (requires `mime`+`url`), `agent` (requires `name`)
  - At least one content-carrying part (text/file/agent) required

- `packages/web/server/lib/conversations/registry.js`
  - In-memory operation registry keyed by messageID
  - `fingerprint(sanitized)` — stable canonical string of sanitized input
  - `createOperationRegistry({ maxEntries?, ttlMs?, clock? })` — creates registry with configurable limits
  - `run(key, fingerprint, factory)` — dedup, conflict detection, caching, eviction
  - Returns `{ status: 'ran'|'dedup'|'conflict'|'unavailable', result, phase }`
  - Factory throws → entry deleted, returns internal result (retry allowed)

- `packages/web/server/lib/conversations/service.js`
  - Core orchestration: `createAndPrompt({ sanitizedInput })` — no external signal parameter
  - Dependencies: `buildOpenCodeUrl`, `getOpenCodeAuthHeaders`, `markUserMessageSent`, `waitForOpenCodeReady`, `logger`
  - Internal bounded timeouts: 30s create, 45s prompt, 6s readiness (all with `AbortSignal.timeout`)
  - `session.create` only receives title/parentID/metadata/directory
  - `session.prompt` receives model/agent/variant/parts and `delivery: "steer"` — Host does not persist parts/text
  - Calls `safeMark(markUserMessageSent)` (swallows errors) ONLY on: success, or ambiguous prompt outcomes
  - All client-facing errors are sanitized
  - Returns discriminated result (see Result Union below)

- `packages/web/server/lib/conversations/routes.js`
  - `POST /api/openchamber/conversations` Express route
  - Validates → fingerprints → registry.run → sends result
  - HTTP statuses:
    - 201 — success
    - 400 — validation, permanent prompt failure, permanent create 4xx
    - 409 — conflict (same messageID, different payload)
    - 502 — ambiguous prompt, transport/5xx create failure
    - 503 — unavailable (all registry entries inflight)
    - 500 — internal error
  - All responses structured JSON
  - Client disconnect does NOT abort operation; route skips writing to destroyed/finished response
  - No AbortController wiring — service uses internal timeouts

- `packages/web/server/lib/conversations/registry.test.js`
  - 17 tests: fingerprint stability, ordering, null/undefined, parts order; registry run/dedup/conflict/concurrent/complete-cache/TTL-expiry/eviction/capacity-unavailable/factory-throw-internal/snapshot

- `packages/web/server/lib/conversations/service.test.js`
  - 44 tests: validation, readiness, create/prompt errors, promptAsync usage, no agent in create, permanent vs ambiguous, markUserMessageSent, safeMark, internal timeouts, AbortError mapping

- `packages/web/server/lib/conversations/routes.test.js`
  - 9 integration tests: validation, delivery reject, empty text, concurrent dedup, conflict 409, internal 500, cached result reuse, client disconnect no abort, conflict status mapping

## Public exports

### validation.js
- `validateConversationInput(body)` → `{ valid, errors?, sanitized? }`

### registry.js
- `fingerprint(sanitized)` → stable string
- `createOperationRegistry(deps?)` → `{ run, snapshot }`

### service.js
- `createConversationsService(deps)` → `{ createAndPrompt }`
  - `deps.buildOpenCodeUrl(path, prefixOverride?)`
  - `deps.getOpenCodeAuthHeaders()`
  - `deps.markUserMessageSent(sessionID)`
  - `deps.waitForOpenCodeReady(timeoutMs?, intervalMs?)`
  - `deps.logger` (defaults to `console`)

### routes.js
- `registerConversationRoutes(app, deps)`
  - `deps.buildOpenCodeUrl`, `getOpenCodeAuthHeaders`, `markUserMessageSent`, `waitForOpenCodeReady`

## Request contract

```json
POST /api/openchamber/conversations
{
  "input": { "type": "prompt" },
  "directory": "/path/to/repo",
  "messageID": "msg_abc123",
  "model": { "providerID": "openai", "modelID": "gpt-4o" },
  "parts": [
    { "type": "text", "text": "hello" },
    { "type": "file", "mime": "text/plain", "url": "file:///test.txt" },
    { "type": "agent", "name": "builder" }
  ],
  "title": "Optional title",
  "parentID": "optional_parent",
  "agent": "builder",
  "variant": "fast",
  "metadata": { "key": "value" }
}
```

**Not supported**: `delivery`, `format`, or any other fields not in the whitelist.

## Result union

| Phase | HTTP | Meaning |
|-------|------|---------|
| *(success)* | 201 | Session created + prompt admitted; `{ ok: true, session, messageID }` |
| `validate` | 400 | Request validation errors; `errors[]` included |
| `conflict` | 409 | Same messageID with different payload |
| `unavailable` | 503 | All registry entries inflight; retry later |
| `create` | 400 | Permanent 4xx upstream from session.create |
| `create` | 502 | Transport/5xx/readiness failure during create |
| `prompt` | 400 | Permanent 4xx — prompt rejected |
| `prompt` | 502 | Ambiguous (408/429/5xx/transport) — prompt may have been accepted |
| `internal` | 500 | Unhandled exception |

All prompt-phase results include `session` and `messageID` for client surface.

## Ambiguity rules
- **ambiguous = true**: no HTTP response (transport), or 408/429/5xx
- **ambiguous = false**: permanent 4xx (400-407, 409-428, 430-499)
- `markUserMessageSent` called only on success and ambiguous=true

## Timeouts
All SDK calls use internal bounded `AbortSignal.timeout`:
- Readiness wait: 6s
- `session.create`: 30s
- `session.prompt`: 45s

## Error safety
- Client-facing errors are stable generic strings
- Original errors logged via `console.warn` (phase, status, ambiguous flag — no bodies/paths/ports/secrets)
- `safeMark` wraps `markUserMessageSent` — throws caught and warned, never propagate

## Notes for contributors
- Registry is per-`registerConversationRoutes` call (per Express app instance)
- Completed entries TTL is 5 minutes; only completed entries are evicted
- `fingerprint` skips null/undefined values; key order is stable; parts order is preserved
- Client disconnect skips response write but operation completes and result is cached
- Factory throws (unexpected) delete the entry to allow retry with the same key
- No GET status endpoint; repeat POST with same payload reuses in-flight/cached result

(End of file)
