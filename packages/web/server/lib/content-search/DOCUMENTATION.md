# Global conversation content search

The Host owns `content-search.sqlite` alongside the session index. This index is
independent of browser transcript caches and includes all projects exposed by the
active OpenCode runtime. `session.list` is called without a project/directory
filter; opaque cursors are followed until exhausted. The default coverage is
messages created in the last seven days in recently updated sessions.

Two workers page native `message.list` directly, normalize via the shared server
projection, and retain only user text and settled assistant text. Synthetic,
ignored, slim, reasoning, attachments and tool parts are excluded. Assistant
excerpts keep at most 2048 characters; user text stays complete. A session's
projection and updated-time checkpoint commit together only after all its pages
succeed. Failures preserve previous hits and retry on subsequent scans. Restarts
skip unchanged sessions using persisted checkpoints. Failed catalog reads never
trigger deletion. Successful catalogs remove deleted sessions; seven-day expiry
removes old message rows and corresponding FTS entries.

Global upstream events mark sessions dirty and coalesce a scan within one second;
a 30-second reconciliation discovers missed events. Indexing does not depend on
any UI session being opened. Runtime identity is owned by the Host session index;
in-flight results are rejected if it changes. Stop aborts reads and drains the
active pass before closing SQLite.

`GET /api/openchamber/content-search?q=...&limit=30` returns `{hits,index}`.
Each hit includes authoritative session title and directory plus message identity,
role, created time and a plain snippet. The optional `directory` narrows searches;
omitting it searches every project. The endpoint uses the existing Host auth and
rejects preview-proxy credentials. Errors are not converted to empty successes.
An empty query returns index coverage/progress without hits. Index phase is
pending/indexing/ready/partial/error; previously completed coverage stays usable
during incremental scans.

FTS5 trigram MATCH narrows candidates for terms of at least three Unicode code
points; exact substring checks preserve AND semantics. Short terms use a scoped
scan. UI queries use runtime-scoped keys and refresh while search is open. No
browser IndexedDB contents or client-supplied generation determines visibility.
