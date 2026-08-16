# Transcript Cache Runtime

This module is the Electron / local-server SQLite backend for settled
transcript messages. It is a **local acceleration cache**, not an authority:
OpenCode remains the source of truth, and a missing or rebuilt database only
means the next hydrate refetches.

The cache is **opt-in**. `resolveTranscriptCacheDbPath` returns `null` unless
`transcriptCacheDbPath` or `OPENCHAMBER_TRANSCRIPT_CACHE_DB_PATH` is set.
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
`close`. `clearAll()` wipes every scope in one transaction by deleting the
index; FK cascade empties the content table. The cache remains writable
afterwards. This is the privacy-clear path for the current Electron local
runtime and does not touch OpenCode history.

## HTTP routes

Registered by `registerOpenChamberRoutes` **before** the generic OpenCode
proxy, on the existing UI-password / CORS path. Prefix:

`/api/openchamber/transcript-cache`

| Method | Path | Action |
|---|---|---|
| `GET` | `/session` | Read a scoped timeline (`transport`, `generation`, `directory`, `sessionID` query) |
| `GET` | `/message` | Read one message (scope query + `messageID`) |
| `PUT` | `/message` | Upsert a settled message (`{ scope, info, parts }`) |
| `DELETE` | `/message` | Remove one message (`{ scope, messageID }`) |
| `DELETE` | `/session` | Clear one scope |
| `DELETE` | `/generation` | Clear one `transport + generation` |
| `DELETE` | `/all` | Clear every cached scope on this machine |
| `POST` | `/evict` | Byte-budget LRU (`{ maxBytes, protect? }`) |

A missing service returns **501**. Invalid scope, message ID, or body returns
**400**. Preview-proxy capability credentials (`oc_preview_token` query or
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
