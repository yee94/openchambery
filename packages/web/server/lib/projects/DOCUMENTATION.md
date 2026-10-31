# Projects

`registry.js` owns registering existing directories. It reuses `validateDirectoryPath`, deterministic
path-derived IDs and the settings runtime's serialized persistence. The existing
`POST /api/opencode/directory` API and assistant business tools share this owner.
The HTTP API still selects the active directory; assistant registration does not
change an existing active selection. The first registered project becomes active
through the existing settings invariant.

Registration is not filesystem creation or cloning. Those operations must finish
before registration. Paths are validated and canonicalized before deduplication.
Concurrent registrations apply against the latest settings under the existing
Host/Electron exclusive write lock, preserving unrelated settings and projects
(including temporarily unavailable directories). Existing IDs, ordering, custom
labels and metadata survive repeat registration. It does not add project label-edit
or removal APIs, and never deletes files, sessions or task storage.

Trusted registry operations use the settings owner's functional update form.
It performs a strict read inside the same persistence lock and follows the normal
normalization, migration, atomic write and project-order SSE notification paths.
Unlike full-list UI replacement, this form does not sweep other projects for
missing directories: callers validate the affected resource. Corrupt reads and
failed writes are errors, not empty state or successful registration. No new
database, settings file, HTTP mutation surface or client sync protocol is added.

`registry.test.js` covers canonical alias deduplication, concurrent append/settings
writes, persistence, offline-project retention, corrupt
reads and failed-write preservation. Assistant HTTP integration is covered in
`../assistants/yuri-project.http.test.js`.
