# Session metadata store

OpenChamber-owned per-session metadata for Host features that used to live on
OpenCode `session.metadata`.

## Why

OpenCode 2.x accepts `metadata` only at session create time. There is no
`PATCH /session/:id` (or equivalent) to update it afterwards. Session goal
progress — and later other Host state under the same namespace — therefore
lives in this Host store and is folded back onto proxy session list/detail
responses so clients still read `session.metadata`.

## Layout

| File | Role |
|---|---|
| `session-metadata-store.js` | Durable store: one JSON file per data dir, `{ [sessionID]: metadata }`, RFC 7386 merge patch, refuse-failed-read refuses write |
| `routes.js` | `PUT /api/openchamber/sessions/:sessionId/metadata` + re-exports `createSessionMetadataStore` |
| `*.test.js` | Store + route contracts |

## Contracts

- Writes are JSON Merge Patch (RFC 7386): nested objects merge key-by-key; `null` deletes a key.
- A failed file read is **not** empty success — the store refuses writes until a load succeeds, so unknown disk state is never overwritten with `{}`.
- Entries are keyed by `sessionID` only (not directory).
- Successful `PUT` may broadcast `openchamber:session-metadata` with the **full** merged metadata object.

## Server wiring

Wired from `packages/web/server/index.js`:

1. `createSessionMetadataStore({ dataDir: OPENCHAMBER_DATA_DIR })`
2. proxy `getStoredSessionMetadata: () => store.getAll()`
3. session-goal `readSessionMetadata` / `persistSessionGoal`
4. `registerSessionMetadataRoutes` — a successful PUT notifies the goal runtime with a synthetic `session.updated` so a UI create/resume arms the loop

Capability is open (`supported: true`). Manual UI metadata writes, session-goal
routes, and scheduled-task goal create all persist `openchamber.goal` through
this store. After first create/resume persist, the server notifies the goal
runtime with a synthetic `session.updated` so the loop can arm.
