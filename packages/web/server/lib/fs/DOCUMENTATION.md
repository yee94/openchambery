# FS Module Documentation

## Purpose
Own filesystem API behavior for the web server runtime, including file operations, directory listing, reveal, and background command execution jobs.

## Entrypoints and structure
- `packages/web/server/lib/fs/routes.js`: route registration and runtime-owned state for `/api/fs/*` endpoints.
- `packages/web/server/lib/fs/search.js`: fuzzy filesystem search runtime used by non-FS routes (for example project icon discovery).

## Public exports
- `registerFsRoutes(app, dependencies)` from `routes.js`
  - Registers all filesystem routes:
    - `GET /api/fs/home`
    - `POST /api/fs/mkdir`
    - `GET /api/fs/read`
    - `GET /api/fs/stat` (includes an `isBinary` classification from an 8 KiB file sample)
    - `GET /api/fs/raw`
    - `GET /api/fs/serve/:path(*)`
    - `POST /api/fs/write`
    - `PUT /api/fs/prompt-attachments/:attachmentID` (binary prompt attachment; returns `{ path, size, mime, sha256 }`). Chat uses `?storage=temporary`: bytes stream into a private `<os.tmpdir()>/openchamber-prompt-*/<filename>` on the active model host, including relay clients. The query parameter deliberately avoids adding a CORS request header: Electron UI OTA updates retain installer-owned backends and their fixed preflight allowlist. Older hosts ignore the query and continue accepting uploads within their existing 25 MiB limit in the content-addressed store; temporary/large-file storage requires an updated host. Temporary storage has no model-context byte limit; size and SHA-256 are verified before returning, and failed/aborted uploads are removed. Successful files remain for later tool reads until OS/user temporary-file cleanup. The legacy/default mode retains the 25 MiB content-addressed store under `<openchamberDataDir>/prompt-attachments/<sha256-prefix>/<sha256><ext>`; Assistant storage is unchanged.
    - `POST /api/fs/delete`
    - `POST /api/fs/rename`
    - `POST /api/fs/reveal`
    - `POST /api/fs/exec`
    - `GET /api/fs/exec/:jobId`
    - `GET /api/fs/list`
  - Owns exec job queue state (`execJobs`) and lifecycle/TTL pruning.
  - Read-only file endpoints accept paths outside the active workspace; mutating and command endpoints enforce workspace boundary checks with active project + worktree fallback support.
- `createFsSearchRuntime({ fsPromises, path, spawn, resolveGitBinaryForSpawn })` from `search.js`
  - Returns `{ searchFilesystemFiles(rootPath, options) }`.
  - Supports fuzzy matching, hidden-file handling, and optional `git check-ignore` filtering.

## Composition contract with `index.js`
- `index.js` provides composition-time dependencies only (platform primitives + callbacks such as `resolveProjectDirectory`, `normalizeDirectoryPath`, and `buildAugmentedPath`).
- `index.js` no longer owns FS route handlers or FS exec job state.

## Notes for contributors
- Keep filesystem policy (read access, workspace root checks for mutations, error mapping, exec timeout behavior) inside this module, not in the composition root.
- Optional `GET /api/fs/read` responses retain their `text/plain` body and set `x-openchamber-file-exists` to `true` or `false` so empty files remain distinguishable from missing files.
- If adding new `/api/fs/*` endpoints, add them in `routes.js` and extend this document.
