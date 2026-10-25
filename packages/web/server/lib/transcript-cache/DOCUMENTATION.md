# Transcript Cache Runtime

This module is the Electron / local-server SQLite backend for settled
transcript messages. It is a **local acceleration cache**, not an authority:
OpenCode remains the source of truth, and a missing or rebuilt database only
means the next hydrate refetches.

The cache is **opt-in**. `resolveTranscriptCacheDbPath` returns `null` unless
`transcriptCacheDbPath` or `YURI_TRANSCRIPT_CACHE_DB_PATH` is set.
Ordinary remote Web servers therefore do not persist conversation bodies.
Explicit and env values are normalized to an absolute path. Only `.sqlite`
files are accepted; the managed `session-index.sqlite` and
`message-queue.sqlite` basenames are rejected. Invalid values return `null`.
A user-chosen cache file such as `transcript-cache.sqlite` remains valid.

`createTranscriptCacheService({ dbPath })` returns `null` when `dbPath` is
empty. Schema version mismatches rebuild the two cache tables instead of
running compatibility migrations. WAL and `foreign_keys` are enabled. The
service `close()`s the SQLite connection on shutdown.

## Storage contract (aligned with ticket 08)

- Identity is `transport + generation + directory + sessionID + messageID`.
  Content hash is never a primary key.
- Timeline order is `(time.created, messageID)`.
- SHA-256 of canonical JSON (`info` + `parts`) detects change only. Same
  identity plus same hash skips the write and refreshes `lastAccessedAt`.
- Settled assistants (`finish` or `time.completed`) and every non-assistant
  row may be written. Open assistant turns are skipped as `not-settled`.
- A full record is never replaced by a later slim write. Slim may upgrade to
  full.
- Two tables: `transcript_cache_index` (light index) and
  `transcript_cache_content` (JSON bodies). Deletes and byte-budget LRU go
  through the index so `ON DELETE CASCADE` keeps the content table aligned.

Public service surface: `readSession`, `readMessage`, `upsertSettled`,
`removeMessage`, `clearSession`, `clearGeneration`, `clearAll`, `evictToBytes`,
`searchContent`, `close`. `clearAll()` wipes every scope in one transaction by
deleting the index; FK cascade empties the content table. The same transaction
deletes content-search rows. The cache remains writable afterwards. This is
the privacy-clear path for the current Electron local runtime and does not
touch OpenCode history.

## Content search

When the cache is enabled, settled writes also project a searchable excerpt
into `transcript_content_search` and its FTS5 trigram index. The index is not
an authority and is rebuilt from scratch when its own schema version changes;
that rebuild does not drop transcript cache rows.

Projection rules:

- `user` messages index every non-empty `text` part, uncapped.
- Settled `assistant` messages index `text` parts only, capped at 2048
  characters (first 1024 and last 1024 when longer).
- Reasoning, tool, file, and other non-text parts are dropped. Other roles
  and whitespace-only text are not inserted. Open assistant turns stay
  unindexed until they settle.
- Replacing a message replaces its excerpt. Message, session, generation,
  cache-wide, and eviction deletes remove the matching excerpts in the same
  transaction.

Startup calls `rebuildContentSince(now - 7 days)` once, off the request path. It projects settled rows already in this cache and does not read OpenCode. Messages older than seven days, or never written into the cache, stay unsearchable until a later settled write.

`searchContent({ transport, generation, directory }, query, { limit })` is
directory-wide. It does not take a session id. Terms split on whitespace are
AND-ed. An empty query returns `{ hits: [] }`. Each hit is
`{ sessionID, messageID, role, createdAt, snippet }`. The default limit is 30
and the cap is 50.

## HTTP routes

Registered by `registerYuriRoutes` **before** the generic OpenCode
proxy, on the existing UI-password / CORS path. Prefix:

`/api/yuri/transcript-cache`

| Method | Path | Action |
|---|---|---|
| `GET` | `/search` | Directory-wide content search (`transport`, `generation`, `directory`, `q`, optional `limit`). Returns `{ available, hits }`. Does not require `sessionID`. |
| `GET` | `/session` | Read a scoped timeline (`transport`, `generation`, `directory`, `sessionID` query). Optional `includeReasoning=false` (strict) strips `type=reasoning` parts on the response only. |
| `GET` | `/message` | Read one message (scope query + `messageID`). Same `includeReasoning` projection as session read. |
| `PUT` | `/message` | Upsert a settled message (`{ scope, info, parts }`) |
| `DELETE` | `/message` | Remove one message (`{ scope, messageID }`) |
| `DELETE` | `/session` | Clear one scope |
| `DELETE` | `/generation` | Clear one `transport + generation` |
| `DELETE` | `/all` | Clear every cached scope on this machine |
| `POST` | `/evict` | Byte-budget LRU (`{ maxBytes, protect? }`) |

A missing service returns **501**. Invalid scope, message ID, or body returns
**400**. Preview-proxy capability credentials (`yuri_preview_token` query or
cookie, via `hasPreviewProxyCredential`) return **403**. Ordinary
UI-password / authenticated requests continue to work. Logs never include
message bodies, parts, or tokens.

This prefix parses JSON itself with the route-local `withJson` helper. It
has no `core-routes` body-parser allowlist dependency. Keep parsing here so
a second parser cannot drift from this module's 72mb / error-mapping
semantics, and so remote servers that leave the cache disabled never grow a
new on-disk parser path for conversation bodies.

Electron injects `transcriptCacheDbPath` into `startWebUiServer`. UI wiring
and end-to-end hydrate remain outside this module.
