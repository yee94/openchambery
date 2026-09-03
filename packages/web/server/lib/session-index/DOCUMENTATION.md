# Session Index Runtime

Every OpenChamber Web Server enables `session-index.sqlite` in its data
directory by default. Electron injects its user-data path explicitly.
`sessionIndexDbPath` and `OPENCHAMBER_SESSION_INDEX_DB_PATH` override that
default; the HMR startup script uses the environment override to isolate its
development index without changing settings or authentication storage.
Rows are partitioned by a runtime key derived from the desktop
`apiBaseUrl` (Electron falls back to the local sidecar URL so the key stays
stable between server listen and window activation).
`service.js` exclusively owns the WAL database and stores at most the
newest 20 root-session summaries per runtime and directory. It never stores
messages, attachments, permissions, provider data, or model metadata.
Sessions titled `smartfetch-secondary` are temporary SmartFetch model calls;
the index excludes them from every snapshot and clears prior summaries when a
  matching session update arrives. System-owned sessions are excluded by
  authoritative metadata only: a non-empty
  `metadata.openchamber.assistant.assistantID` (unless
  `metadata.openchamber.assigned.from === 'contact'` — those are visible
  coding workers the Assistant subscribed to),
  `metadata.openchamber.scheduledTask.taskID`, or
  `metadata.openchamber.smallModel.purpose`. Title prefixes are human labels and
  never participate in this filter. Metadata is the ownership/isolation signal;
`time.archived` is archive state; `time.pinned` is OpenChamber-owned pin state
overlaid from the independent `session_pin` table (also mirrored onto in-window
`session_summary.pinned_at` for older readers). Pins are not subject to the
newest-20 summary bound: evicting or rebuilding a directory keeps pin
membership, and `setPinned` can target a session that is not currently in the
index. Archive or `remove` still clears the pin. Live OpenCode upserts never
overwrite pin membership. Titles are for recognition. The index does
not cache system sessions, so cold-start and live upserts stay aligned with
ordinary sidebar lists.
Pin and unpin use `POST` / `DELETE`
`/api/openchamber/session-index/session/:id/pin`, write `session_pin`, then
`publishChange()` so revision tips broadcast `openchamber:session-index-changed`.
Snapshots include `pinnedSessionIds` plus `time.pinned` on any matching
summary row.

The server-side global OpenCode event subscriber writes session summary events
directly into this index. User `message.updated` events and `session.idle`
completion events advance the separate `activity_updated_at` ordering field,
while session status transitions update `status` and `status_changed_at`.
Renderer event handling never performs these index writes and assistant
streaming events never change session ordering.
Repeated session summary events whose bounded root summary or child membership
is unchanged leave directory recency and the public revision unchanged. Root
events that remain outside the newest-20 bound follow the same no-op path.

`sync-runtime.js` owns cold-start synchronization. The renderer submits all
known project directories once to `POST /api/openchamber/session-index/sync`.
The runtime processes them sequentially, applies `start=lastSyncedAt` for
recent indexes, performs a full reconciliation after 24 hours, and commits each
result to SQLite. A directory is incrementally eligible only when it already
has at least one cached root summary; empty cached directories always request
the full newest page, because a successful `[]` still stores `lastSyncedAt` as
a worktree-topology hint and reusing that watermark as `start` would hide older
historical roots until the next full pass. Request count stays one GET per
directory (`limit=20`). It publishes an in-memory revision after every
externally observable index or synchronization-state change. A successful empty
directory refresh remains in the snapshot so another client can use it as a
worktree-topology recovery hint. Stopping the runtime marks queued and in-flight
directories as failed in the published progress snapshot so clients can retire
their matching loading state.

The renderer observes revisions through OpenChamber SSE tip events
(`openchamber:session-index-changed`). Each tip carries the new revision and
optional sync progress flags; the renderer then GETs
`/api/openchamber/session-index` for the authoritative snapshot. Reconnecting
never needs an event replay log because the next tip or `event-stream-ready`
triggers a fresh snapshot load. Tip waits also use a short safety timeout and
re-GET when a completion tip can race ahead of the consumer subscription (for
example a fast single-directory manual sync). The renderer keeps this tip
observer active after startup refresh work becomes idle, and successful
event-driven index writes with a semantic snapshot change publish a new
revision tip immediately.

The OpenCode proxy calls `noteInteractiveRequest()` for selected-session reads
and mutations. That aborts the current background list, yields for one second,
then resumes the same directory. Consequently a startup index refresh cannot
sit ahead of conversation content or user actions.

Runtimes that explicitly disable or cannot host the index receive deterministic
`501 unsupported` responses and retain the bounded SDK-backed loading path.
