# Session Turn Pages Module

## Purpose

OpenChamber-owned turn-window pagination and anchor reconcile for session messages.

1. **Turn pages** — clients request the last N **authored user turns** (default 3) rather than a raw message count. The host loops official OpenCode `session.messages` pages (`limit` / `before` / `x-next-cursor`) until the turn budget is met or history is exhausted.
2. **Anchor reconcile** — after SSE reconnect, clients request the gap from a stable turn-boundary anchor to the current head. The host scans newest→older, returns chronological gap records (including the anchor's overlap turn), and paginates via host-owned continuation tokens with page/byte/total budgets.

Exposed as:

- `GET /api/openchamber/sessions/:sessionID/messages`
- `GET /api/openchamber/sessions/:sessionID/messages/reconcile`

## Why this exists

Official OpenCode pagination is message-count based and uses **opaque** cursors (not message ids). Each upstream page is chronological **old→new** (including the latest slice). UI prepend/load-more needs a stable turn boundary so synthetic loop messages, subtasks, and compaction rows do not consume the turn budget. This module aggregates upstream pages on the host, returns chronological records, and exposes a continuous **host-owned opaque cursor** that points just before the earliest returned authored user.

## Scope

- OpenChamber feature logic, separate from the generic OpenCode proxy.
- Registered in `feature-routes-runtime.js` **before** the generic proxy.
- Global `/api/*` auth is enforced by `core-routes.js` (`requireApiAuth`); this module does not add redundant auth middleware.
- No secrets, bearer tokens, pairing credentials, paths, or upstream response bodies are logged.
- Host cursors never embed message content — only boundary location metadata.

## Query contract

| Param | Default | Range | Notes |
|---|---|---|---|
| `turns` | `3` | `1..10` | Authored user turn budget (product limit) |
| `scanLimit` | **omitted** | `10..200` when present | Optional override only. Host→OpenCode local page size; default is server `_inner_scanLimit` (`OPENCHAMBER_SESSION_TURN_SCAN_LIMIT` or `100`). Clients should omit this. |
| `before` | omitted | opaque string ≤ 8192 chars | Resume older history: host cursor (`oc1.…`) or raw OpenCode SDK cursor on first page |
| `directory` | omitted | path string | Forwarded to directory-scoped OpenCode client |

Invalid `turns`, explicit invalid `scanLimit`, or `before` (malformed/stale host token, oversize) → HTTP 400.

**`_inner_scanLimit`**: resolved once at process start from env (clamped 10..200). Host always calls OpenCode on loopback; scan chunk is not a client-network concern. Final response size is still turn-trimmed via `selectTurnRecords`.

## Response contract

Success `200`:

```json
{
  "records": [{ "info": { "id": "...", "role": "user" }, "parts": [] }],
  "turnCount": 1,
  "cursor": "oc1.…",
  "complete": false
}
```

- `records`: chronological oldest → newest, including intermediate non-boundary rows (synthetic, tools, subtask, compaction) inside the window.
- `turnCount`: count of authored user boundaries in `records`.
- `cursor`: host-owned opaque token for the next `before=` request; `null` when `complete` is true. The token represents the position **just before** the earliest returned authored user (so the client can load older history without overlap).
- `complete`: `upstreamComplete && selected.length === accumulated.length`. True when upstream history is exhausted **and** `selectTurnRecords` did not trim any older scanned rows (nothing left for the client). When the scan window held more than N turns and older rows were trimmed, `complete` stays `false` with a `cursor` so the client can fetch the trimmed history.

## Host cursor format

Versioned self-describing token:

- Prefix: `oc1.`
- Body: base64url(JSON) of `{ "v": 1, "before": string | null, "boundaryID": string }`
  - `before`: the **raw upstream request-before** used to fetch the page that contained `boundaryID` (`null` = latest page / no before).
  - `boundaryID`: message id of the earliest authored user returned in that response.

On resume:

1. Strict decode / shape / length validation of the host token.
2. First `fetchPage` uses the token’s raw upstream `before`.
3. Locate `boundaryID` in that page; keep only records strictly older than it (`slice(0, index)` in old→new order). Boundary and newer rows are excluded.
4. If fewer than N turns remain, continue with that raw page’s `x-next-cursor` for older pages.
5. Each accumulated record records its upstream page’s request-before origin; when `complete=false`, the next host cursor encodes the earliest selected authored user’s origin + id.

A raw OpenCode SDK cursor (no `oc1.` prefix) is still accepted as the first `before` and is passed through unchanged to `fetchPage`.

Malformed host tokens, missing/stale `boundaryID`, or `before` longer than 8192 → `invalid_cursor` → HTTP 400.

## Turn boundary predicate

A message is an authored user turn boundary when:

1. `(clientRole ?? role) === 'user'`
2. Not a hosted session divider (`info.id` starts with `oc_asst_session_divider:`)
3. Not a message whose parts include `subtask` or `compaction`
4. Not fully synthetic (every part has `synthetic: true`) — loop / plan / shell injections
5. Empty `parts` on a user message **does** count as a boundary
6. Mixed real + synthetic parts **does** count as a boundary

## Aggregation rules

- Upstream pages are chronological **old→new** within each page; **do not reverse**. Older pages are **prepended** while deduping by `info.id` (global order remains old→new).
- Continues paging with raw upstream `before` until `turns` authored boundaries are collected or upstream reports no next cursor.
- Every upstream record must have a non-empty `info.id`; otherwise structured error, no partial `records`, HTTP 502.
- Hard scan caps (no partial success): **50 pages** / **5000 messages** → structured error, HTTP 413.
- Repeated / stalled cursor, or empty page that still carries a next cursor → structured error, no partial `records`, HTTP 502.
- Malformed upstream payloads and SDK/transport failures → HTTP 502 (`error: "upstream"`).
- `AbortSignal` is forwarded to each `session.messages` call; route also applies a 45s linked timeout.
- Request abort only when the client disconnects mid-flight: `req` aborted, or `res` `close` while `!res.writableEnded`. A normal GET request `close` after the response has ended must not abort.

## Anchor reconcile API

### Request

```http
GET /api/openchamber/sessions/:sessionID/messages/reconcile
  ?directory=<workspace>
  &anchor=<messageID>
  &continuation=<opaque-token>
```

| Param | Notes |
|---|---|
| `anchor` | First request only. Stable server-confirmed message id (turn boundary). Max 512 chars. |
| `continuation` | Subsequent pages. Host opaque signed token (`ocr2.<payload>.<mac>`). Mutually exclusive with `anchor`. Max 8192 chars. |
| `directory` | Optional path forwarded to directory-scoped OpenCode client; bound into continuation. |

Provide **exactly one** of `anchor` or `continuation`. Invalid params → HTTP 400.

### Response (`200`)

```json
{
  "records": [{ "info": { "id": "..." }, "parts": [] }],
  "anchorFound": true,
  "capturedHeadMessageID": "msg_latest_at_round_start",
  "latestHeadMessageID": "msg_latest_probe",
  "continuation": "ocr2.…",
  "complete": false,
  "resetRequired": false,
  "scannedRecords": 42,
  "responseBytes": 1200
}
```

- `records`: chronological oldest → newest for this response page. Includes the **overlap turn** starting at the anchor user (and subsequent assistant/tool rows) so in-progress parts and finish updates re-enter recovery merge.
- `anchorFound`: true once the anchor id has been located in the scanned window (may be true on a later continuation page).
- `capturedHeadMessageID`: head message id fixed for the reconcile **round** (first latest-page fetch).
- `latestHeadMessageID`: when `complete` and not `resetRequired`, a fresh head probe; otherwise equals captured head.
- `continuation`: host token for the next page; `null` when `complete` is true.
- `complete`: no further pages for this round (gap delivered, or terminal reset).
- `resetRequired`: client must drop transcript Query and rebuild from authoritative tail. True when:
  - history exhausted without finding the anchor; or
  - total page/byte budget of the round is hit before the gap is complete.
- Natural exhaustion and budget rebuild both use **HTTP 200** (not 4xx/5xx).

### Continuation binding and lifetime

Signed token format:

```text
ocr2.<base64url(json-payload)>.<base64url(hmac-sha256(payload))>
```

Payload (never message content or parts):

```ts
{
  v: 2,
  runtime: string,          // host runtime key (OPENCHAMBER_RUNTIME or inject)
  directory: string | null,
  sessionID: string,
  anchor: string,
  capturedHead: string,
  scanBefore: string | null, // raw upstream before for older history (null = re-fetch latest)
  returnedThroughID: string | null, // oldest id already returned; resume slices older than it
  scannedRecords: number,
  scannedBytes: number,
  pagesEmitted: number,
  iat: number,              // issued-at unix seconds
  exp: number,              // expiry unix seconds
}
```

Security / lifecycle:

- MAC: Node `crypto.createHmac('sha256', secret)` over the base64url payload; verified with `timingSafeEqual`.
- Default secret: process-ephemeral random 32 bytes. **Host restart invalidates all outstanding continuations** (`invalid_continuation` → HTTP 400); client must restart the round from `anchor`.
- Default TTL: 15 minutes. Expired tokens → `invalid_continuation` (HTTP 400).
- Rejects: legacy unsigned `ocr1.*`, wrong MAC, wrong secret, structural anomalies, unknown keys, binding mismatches (runtime/directory/session/anchor/captured head).
- Service options for tests: `continuationSecret`, `clock`, `continuationTtlMs`.

### Budgets (server-owned)

| Budget | Default | Env override |
|---|---|---|
| Per-page records | 100 | `OPENCHAMBER_SESSION_RECONCILE_PAGE_RECORDS` (1..500) |
| Per-page JSON bytes | 512 KiB | `OPENCHAMBER_SESSION_RECONCILE_PAGE_BYTES` |
| Total pages / round | 20 | `OPENCHAMBER_SESSION_RECONCILE_TOTAL_PAGES` (1..100) |
| Total scanned bytes / round | 5 MiB | `OPENCHAMBER_SESSION_RECONCILE_TOTAL_BYTES` |

When the per-page budget fills before the gap is complete, the host returns `continuation` and HTTP 200. When the **total** round budget hits without completing the gap, the host returns `resetRequired: true` and HTTP 200.

### Reconcile scan rules

- Upstream pages chronological old→new; older pages prepended with id dedupe.
- First request of a round captures head from the latest page, then walks older until anchor or budgets/history end.
- Continuation re-slices already-returned suffix via `returnedThroughID` and resumes older history via `scanBefore`.
- Missing id / empty+cursor / stalled cursor → structured error, no partial success body for that error path, HTTP 502.
- OpenCode temporary failures → `upstream` (502) or `unavailable` (503).
- Unexpected server exceptions → HTTP 500; logger records full stack with session id and flag fields only (no auth headers, no message/parts content).

## Files

- `service.js` — `isUserAuthoredTurnBoundary`, `selectTurnRecords`, `encodeHostCursor`, `decodeHostCursor`, `createSessionTurnPageService({ fetchPage, maxScanPages?, maxScanMessages? })`
- `reconcile.service.js` — `encodeReconcileContinuation`, `decodeReconcileContinuation`, `createSessionReconcileService({ fetchPage, runtimeKey?, page/total budgets?, continuationSecret?, clock?, continuationTtlMs? })`
- `routes.js` — Express registration for both turn-page and reconcile; optional injected `sessionTurnPageService` / `sessionReconcileService` for tests; default wires SDK `session.messages` via `buildOpenCodeUrl` + `getOpenCodeAuthHeaders`
- `service.test.js` / `routes.test.js` / `reconcile.service.test.js` / `reconcile.routes.test.js` — unit contracts

## Registration

```js
// feature-routes-runtime.js (before generic proxy composition)
registerSessionTurnPageRoutes(app, {
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
});
```

Reconcile is registered on the more-specific path **before** the generic messages path inside `registerSessionTurnPageRoutes`.

## Error HTTP map

| Condition | Status |
|---|---|
| Invalid turns / scanLimit / sessionID / cursor | 400 |
| Invalid anchor / continuation / reconcile params | 400 |
| max_scan_pages / max_scan_messages | 413 |
| Client abort | 499 |
| Server exception (reconcile) | 500 (stack logged; safe client body) |
| duplicate cursor / empty+cursor / missing id / upstream | 502 |
| OpenCode unavailable | 503 |
| Anchor not found / total budget → `resetRequired` | **200** |
