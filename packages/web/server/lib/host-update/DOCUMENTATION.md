# Host self-update

`GET /api/system/update?channel=stable|beta` returns the **serving Host's**
identity/version, supported capability, selected/query channel, optional update
plan (exact version, release notes, OTA/installer/CLI kind, rollback and expiry),
and the current operation. Omitting the channel follows the Host's persisted
selection. A check never selects a channel or clears a staged desktop bundle.
Discovery errors return HTTP 502 with `checkError` and the operation snapshot,
not a false up-to-date result. Active tasks remain visible regardless of the
queried channel; discovery is skipped while an update is active.

`POST /api/system/update` accepts `{ version, channel, planId,
allowDowngrade?: true }`. Validation and admission are serialized. Plans are
Host/process/platform/architecture/current-version/channel/artifact bound,
expire after ten minutes, and are freshly revalidated before admission. GET
reuses successful release discovery for at most one minute (two channel slots).
An exact active/completed retry returns the existing operation; conflicting
active requests, stale plans and changed releases return 409. A beta-to-stable
rollback requires explicit `allowDowngrade`; stable never selects a prerelease.
Accepted requests return 202 before starting work. Failed tasks can be retried
only after validation again. No caller-supplied command, URL or update kind is
accepted. Errors contain stable codes, never installer output or credentials.

States are `checking`, `downloading`, `installing`, `restarting`, `succeeded`,
`failed`. Unknown percentage is null. The channel and accepted task are atomically
persisted with private permissions. A new Host verifies a restarting task against
its actual running version; interrupted pre-restart tasks fail rather than
appearing successful. Package installation failure is not package rollback.

## Ownership

- `runtime.js` owns plans, admission, durable task state and restart verification.
- `routes.js` requires a real paired-client bearer or authenticated password UI
  session, refuses URL-auth tokens, unauthenticated loopback and cross-site cookie
  requests. All paired device kinds can update their Host. This is the same
  authorization over direct HTTP and Relay; Relay grants no privilege.
- `releases.js` selects installable exact npm versions from `latest` / `beta`
  tags with beta sequence ordering. GitHub tag release notes are optional; a
  failed registry lookup is not optional.
- `cli.js` launches a hidden detached Node helper and awaits its preflight before
  gracefully stopping the Host. Synchronous package-manager ownership probes run
  in that helper, never on an Electron/server main thread.
- `cli-worker.js` verifies the global install and registered daemon, locks the
  stable installation entry, revalidates registry integrity, waits for the old
  process to exit, installs the exact version, restarts through the global CLI
  entry and verifies `/health` version/identity. Runtime, bind host, port,
  API-only mode and password environment are preserved. Passwords never enter
  task state or helper argv. Install failure attempts to restart the surviving
  CLI files but cannot promise recovery from a partially replaced package.
- Electron injects `host-update.mjs` through `startWebUiServer` and shares
  `DesktopOta` / `DesktopInstaller`, existing download events and graceful
  shutdown / `quitAndInstall`. It never runs a package manager. Local desktop
  check/download activity is exposed by the same GET and blocks remote admission;
  remote tasks block competing updater IPC. Installer feeds remain pinned to the
  release selected by the existing desktop decision, including beta isolation.

## Deliberate limitations

Automatic CLI installation currently requires one registered, writable global
POSIX daemon. Development checkouts, containers, Windows CLI installations,
foreground/service-managed launches and concurrent registered CLI daemons report
unsupported or fail preflight without stopping the Host. Use their installation
or service manager instead. Other data scopes sharing one global installation
must be administratively drained; the installation lock prevents competing
remote helpers but does not coordinate arbitrary external package managers.
A helper killed before its `finally` cleanup leaves an installation lock in the
user cache; an operator must verify no helper remains before removing that lock.
Workers deliberately do not race to reap presumed stale locks.

Packaged non-Preview Electron supports OTA and native installers; development and
Preview report unsupported. Native-main injection requires a new desktop installer,
not merely a UI/backend OTA to an older shell. Mobile/web clients operate the
selected Host through `runtimeFetch`; standalone VS Code returns explicit 501.
The retired unversioned `/api/yuri/update-install` returns 409 `update_plan_required`.

The shared UI puts an icon beside the Host's Yuri version in About and the
desktop remote-instance menu, with an available-update dot and a confirmation
dialog showing channel, notes, method and rollback warning.
The existing outer About beta switch selects the query/submit channel; the
dialog has no independent channel checkbox or preference. In-flight mutations
retain their captured channel and cannot overwrite another channel's Query data.
`hostUpdateDialogModel.ts` adapts the Host DTO to
the existing client updater's shared `UpdateDialogView`; both use the same
overlay, Markdown changelog, scroll/progress/error and footer rendering. No
separate remote dialog is maintained. Query keys include
transport and generation; endpoint changes discard the dialog/mutation scope.
Polling is visible/mounted-only: two seconds during activity, five minutes idle,
and fifteen seconds after a connection error. Reconnect preserves the last task
and never treats a dropped connection as success.

## Verification

Focused Vitest: `runtime.test.js`, `routes.test.js` (real auth and Relay HTTP
dispatcher), Electron `host-update.test.mjs` / `desktop-ota.test.mjs` /
`desktop-installer.test.mjs`, UI `HostVersionUpdate.test.tsx` /
`AboutSettings.test.tsx`. Installation and native process replacement need a
controlled disposable installation; these tests do not update the running app.
