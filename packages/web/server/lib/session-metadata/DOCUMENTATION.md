# Session metadata store

OpenChamber session metadata whose durable copy lives on the OpenCode session
record. The side JSON file is the cache and the pre-migration source.

## Why

Session goal progress, Host archive stamps, titles, and other Host state under
the `openchamber` namespace travel with the OpenCode session. `session.update`
(`PATCH /api/session/:id`, body `{ title?, metadata?, permissions? }`) replaces
`metadata` wholesale. Archive is `metadata.openchamber.archive.archivedAt` on
that record and is still projected onto `time.archived`. Title is the record's
`title` field and is not sent when only metadata changes.

`opencode-session-record.js` is the only module that knows that call. A client
whose types omit `session.update` metadata still goes through that module;
a missing API throws and is never an empty write.

The side file remains until each row has been copied or OpenCode has confirmed
the session is gone. Until that load succeeds, the file is not an authoritative
empty catalog: a failed read stays unwritable and does not clear other sessions.
A session OpenCode still has is listed even when the side file has no row.
One failed copy does not delete the other rows or the other OpenCode sessions.

Fork-specific fields (`goal`, `assistant`, `scheduledTask`, `llm`, `smallModel`,
and the rest of `openchamber`) are merged onto the record. They are not dropped
to match a narrower upstream metadata shape.

| OpenCode client | Session metadata update |
|---|---|
| Earlier 2.x releases used during the migration | `metadata` accepted at create time only |
| 2.0.14+ / 2.0.15 | `PATCH /api/session/:id` with body `{ title, metadata, permissions }` (`session.update`) |

## Layout

| File | Role |
|---|---|
| `opencode-session-record.js` | Read/write title and metadata on the OpenCode session record; migrate the side file without treating a failed load as empty or dropping other sessions |
| `session-metadata-store.js` | Side-file cache and migration source: `{ [sessionID]: metadata }`, RFC 7386 merge patch, full RMW serialization, refuse-failed-read refuses write/read-as-empty. When a record reader/writer is wired, commits the merged object onto the OpenCode session first |
| `session-projection.js` | Pure Host authority projection (metadata deep-merge + archive → `time.archived`) |
| `session-archive.js` | Domain archive/unarchive: validate upstream session + directory, persist, project, best-effort index/broadcast |
| `system-session.js` | Isolation patches for system session creators: `buildScheduledTaskMetadata`, `buildLlmSessionMetadata`, `buildAssistantSessionMetadata`. Title prefixes are labels and never ownership. |
| `routes.js` | `PUT .../metadata`, `PUT .../archive`, re-exports store/archive/projection |
| `*.d.ts` | Sibling type surfaces for Extension Host (`packages/vscode` facades) — runtime stays in `.js` |
| `*.test.js` | Store + route + archive contracts |

## Contracts

- Writes are JSON Merge Patch (RFC 7386): nested objects merge key-by-key; `null` deletes a key.
- Mutations are fully serialized (read-merge-write + persist) so concurrent writers cannot lose neighbors.
- Committed `entries` update **only after** successful persist — concurrent readers never observe uncommitted drafts. Persist failure keeps the last committed snapshot and surfaces the error.
- `mutateSessionMetadata(sessionID, decide)` runs `decide(committedMetadata)` on the same exclusive lock. Return `{ ok: false, reason? }` to reject without writing, or `{ ok: true, patch }` to merge-persist-publish. Session-goal uses this for generation/status preconditions.
- Goal-shaped metadata PUT patches advance `openchamber.goal.executionGeneration` via `withGoalExecutionGeneration` inside the mutate lock (pause/resume/condition changes).
- A failed or **corrupt** file read is **not** empty success — the store stays unwritable, keeps the file, and throws; it does not overwrite unknown disk state with `{}`.
- Entries are keyed by `sessionID` only (not directory). Runtime isolation is the Host data dir. Multiple Hosts sharing one data file are outside the current contract.
- Generic metadata patches **cannot** wipe Host archive: `openchamber.archive` is stripped from the patch and restored after merge (including null ancestor deletes). Archive writes use `setSessionMetadata(..., { allowArchive: true })`.
- Host archive authority (`metadata.openchamber.archive.archivedAt`):
  - positive number → archived (`time.archived` = that value)
  - `0` → explicit unarchive (clears `time.archived` even if upstream still has history)
  - missing → fall back to upstream `time.archived`
- `PUT /api/openchamber/sessions/:sessionId/archive` body `{ archivedAt: number, directory?: string }` returns `{ session, index? }`. Validates upstream id + directory (`location.directory` first). Does not mutate upstream `created`/`updated`. Metadata commit is authoritative; `index: { ok: false, retryable: true }` is observable when SQLite apply fails after commit (`retryIndexUpdate` / `getIndexRepairStatus`).
- When the Host store is wired, proxy list/get return **503 retryable** on metadata read failure (never silent un-overlaid upstream). Until the store is ready, session lifecycle SSE/hub frames are suppressed; transcript/message paths stay open. Hub `replayAfter` re-projects with **current** committed metadata.
- Successful proxy `DELETE /api/session/:id` and assistant SDK delete run idempotent `forgetSession`; `session.deleted` remains compensatory. Upstream delete failure keeps metadata.
- Successful metadata `PUT` may broadcast `openchamber:session-metadata` with the **full** merged metadata object.
- Successful archive broadcasts `session.updated` with projected `info` (global UI + openchamber SSE).
- `session.deleted` events best-effort `removeSession` metadata cleanup.

## Server wiring

Wired from `packages/web/server/index.js` + `feature-routes-runtime.js`:

1. `createHttpSessionRecordClient` + `createSessionMetadataStore({ dataDir, recordReader, recordWriter })` + initial `load()`, then `startSideStoreMigration`
2. proxy `getStoredSessionMetadata` / `getStoredSessionMetadataSync` → list/get + direct SSE overlay
3. global hub `projectOutboundSessionPayload` → live + replay session lifecycle authority
4. session-index sync `projectSessions` + event-ingest `projectSession` / `onSessionDeleted`
5. `createSessionArchiveService` after session index exists
6. session-goal `readSessionMetadata` / `mutateSessionMetadata` / `persistSessionGoal`
7. `registerSessionMetadataRoutes` (metadata + archive)
8. assistants `archiveSessionHost` → shared Host archive, which write-throughs `metadata` onto the OpenCode session record without clearing `title`
9. system session creators persist isolation through `persistSessionMetadata`
   (`setSessionMetadata` + `openchamber:session-metadata` broadcast) and then
   `onSystemSessionPersisted` (index upsert that removes the row). Wired from
   `index.js` into scheduled-task runtime, LLM attachment generate, and
   Assistant binding create. Create-time `metadata` is merged onto the session record; it is not a second authority.

Capability is open (`supported: true`). Manual UI metadata writes, session-goal
routes, and scheduled-task goal create all persist `openchamber.goal` through
this store. After first create/resume persist, the server notifies the goal
runtime with a synthetic `session.updated` so the loop can arm.

Sidebar / session-index / notifications hide a session only when Host metadata
carries a non-empty `openchamber.assistant.assistantID` (unless
`assigned.from === 'contact'`), `openchamber.scheduledTask.taskID`,
`openchamber.smallModel.purpose`, or `openchamber.llm.purpose`. Title prefixes
are human labels and never participate. Every system session creator must
persist the matching patch through this store.
