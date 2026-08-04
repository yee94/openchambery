# Session Turn Pages Module

## Purpose

OpenChamber-owned turn-window pagination for session messages. Clients request the last N **authored user turns** (default 3) rather than a raw message count. The host loops official OpenCode `session.messages` pages (`limit` / `before` / `x-next-cursor`) until the turn budget is met or history is exhausted.

Exposed as:

`GET /api/openchamber/sessions/:sessionID/messages`

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
| `turns` | `3` | `1..10` | Authored user turn budget |
| `scanLimit` | `100` | `10..200` | Per-page upstream `limit` for `session.messages` |
| `before` | omitted | opaque string ≤ 8192 chars | Resume older history: host cursor (`oc1.…`) or raw OpenCode SDK cursor on first page |
| `directory` | omitted | path string | Forwarded to directory-scoped OpenCode client |

Invalid `turns`, `scanLimit`, or `before` (malformed/stale host token, oversize) → HTTP 400 (service not called or `invalid_cursor`).

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

## Files

- `service.js` — `isUserAuthoredTurnBoundary`, `selectTurnRecords`, `encodeHostCursor`, `decodeHostCursor`, `createSessionTurnPageService({ fetchPage, maxScanPages?, maxScanMessages? })`
- `routes.js` — Express registration; optional injected `sessionTurnPageService` for tests; default wires SDK `session.messages` via `buildOpenCodeUrl` + `getOpenCodeAuthHeaders`
- `service.test.js` / `routes.test.js` — unit contracts

## Registration

```js
// feature-routes-runtime.js (before generic proxy composition)
registerSessionTurnPageRoutes(app, {
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
});
```

## Error HTTP map

| Condition | Status |
|---|---|
| Invalid turns / scanLimit / sessionID / cursor | 400 |
| max_scan_pages / max_scan_messages | 413 |
| Client abort | 499 |
| duplicate cursor / empty+cursor / missing id / upstream | 502 |
