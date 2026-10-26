# Yuri shared UI

`@yuriai/ui` owns the shared React surfaces, runtime contracts, state and persistence.
OpenCode package identities and protocols remain third-party contracts.

## Default themes

New preferences use Cursor Dark (`cursor-dark`) and Carbonfox Light
(`carbonfox-light`), following the system appearance. Explicit saved selections
remain authoritative. The web host fills missing theme preferences with the same
defaults; Web, Mini Chat and mobile cold-start backdrops use Cursor's dark surface
until persisted splash colors or the resolved runtime theme are available.

## Sidebar wordmark

The default sidebar brand is `Yuri`. `SidebarBrandMark` renders the approved
sculpted SVG through `YuriWordmark` for each exact, whitespace-separated `Yuri`
word, including mixed names such as `Yee Yuri`. Its width is cap-height-relative
(2.44814cap = 626.723 / 256), matching the visible artwork to the bold
Syne text's cap height. A 0.046875cap downward offset compensates
the SVG's 12-unit bottom padding so visible baselines align. All words use the
same theme foreground. Custom text retains its original 1.0625rem size, 700
weight and 0.08em tracking; Syne loads only when custom text is present.
Whitespace-only names hide the slot. Store version 3 migrates exact historical default
names, preserving other custom values and the existing runtime-scoped storage.

## Brand migration

`src/lib/brand-storage-bootstrap.ts` is the single synchronous same-origin
localStorage coordinator. Storage consumers import it before evaluating persisted
state. It copies product-owned old namespaces into Yuri keys, preserving values
byte-for-byte, including malformed values for their owning store's recovery logic.
Encoded runtime/instance identities are opaque. Existing Yuri keys win; old values
are never deleted. Per-key completion markers prevent intentional deletions from
being resurrected. Failed writes/verification remain retryable on reload; bootstrap
fails closed instead of allowing empty stores to overwrite draft metadata.

The same migration owner gates the five IndexedDB databases used for draft blobs,
assistant attachments, durable transcripts, transcript search and diagnostics.
It snapshots old stores in one readonly transaction, preserves key paths/indexes,
and commits copied records plus a completion marker in one new-database transaction.
Existing records win. A failed transaction leaves the source intact and can retry.
An independently initialized Yuri database is authoritative and is not overwritten.
Completed migrations check only their marker; they do not rescan transcript blobs.
Absent old databases are probed with an aborted creation, so fresh installs do not
create old-brand databases. Neither user text nor stored file URLs are rewritten.

This only covers accessible storage in the **same origin**. Electron's old scheme,
a changed web domain, and a new mobile application sandbox require the owning
runtime's explicit export/import or re-pairing flow. Browser migration cannot read
another origin or transfer native Keychain credentials. The shell must finish any
origin import before loading shared UI modules.

### Legacy read exceptions

| Location | Allowed legacy input | Scope / exit condition |
| --- | --- | --- |
| `src/lib/brand-storage-migration.ts` | Two historical full-brand namespaces and product `oc` storage prefixes | Copy-only storage migration; remove no earlier than the next major migration window, after native import acceptance |
| `src/lib/brand-storage-migration*.test.ts` | Old keys, database names and sample user text | Migration regression fixtures; retire with the migrator |
| `src/apps/deepLinks.ts`, `src/lib/connectionPayload.ts`, `src/apps/deepLinks.test.ts` | Two old URI schemes | Read-only link parsing and regression fixtures; generated links use Yuri, pairing validation/expiry/exchange remain unchanged; retire after old-client migration window |
| `src/lib/theme/themes/index.ts` | Two old built-in theme IDs | Resolve existing preference values; retire after preference migration window |
| `src/sync/input-draft-composer-parser.ts` and its test | Two old serialized draft discriminants | Recover existing paste/reference sidecars without rewriting user text; retire with draft migration |
| `src/lib/messages/inlineMessageLinks.ts` | Old skill/agent fragment prefixes | Read stored message links, emit only Yuri fragments; retain while historical transcripts can contain them |
| `src/components/assistants/AssistantConversationSurface.tsx`, `src/components/assistants/contactMessageTime.ts`, `src/queries/assistantContactMessages.ts` | `oc.settle.*` | Hide persisted internal markers without rewriting transcript content; retain while historical transcripts can contain them |

The UI maintainers own these exceptions. Legacy names are not emitted as new keys,
new URLs or new protocol defaults.

## Runtime contract integration

All runtime owners must agree on `__YURI_*`, `yuri:*`, `/api/yuri`, `Yuri*` native
plugins, `yuri-ui` / `yuri-asset` schemes and `yuri_url_token` / `yuri_preview_token`
query parameters. Product CSS/custom properties/data attributes now use `yuri-*`;
native keyboard, webview and desktop injection code must emit the same names.
The server metadata namespace is `metadata.yuri`; authoritative server migration
must preserve old session goals, reviews, assistant/task membership and title data.
Mixed old shells are not supported by merely changing a display name: the native
bundle/update compatibility gate belongs to the mobile/desktop owners.
Mobile OTA requests carry `applicationId` only from native `App.getInfo().id`.
Missing or unreadable native identity stays absent; the web bundle/config never
supplies a fabricated identity. Old/missing identities can receive an installer
decision but cannot accept or download Yuri OTA. Desktop checks invoke
`desktop_check_for_updates` with only the channel override; Electron supplies the
native identity at its privileged boundary.

Release builds must configure verified update URLs with
`VITE_YURI_EDGEONE_UPDATE_CHECK_URL`, `VITE_YURI_VERCEL_UPDATE_CHECK_URL`,
`VITE_YURI_EDGEONE_OTA_CHECK_URL`, `VITE_YURI_VERCEL_OTA_CHECK_URL`, and
`VITE_YURI_IOS_TESTFLIGHT_URL`. Unconfigured update services use reserved `.invalid`
addresses, and the iOS installer link falls back to the candidate releases page.
These defaults are not a configured or verified release service.

`src/components/ui/YuriLogo.tsx` and `src/assets/brand/yuri-mark-{black,white}.svg`
use the final approved vector geometry. The mark stays black or white; theme
containers own backgrounds. Animation honors reduced motion.

`src/components/ui/YuriWordmark.tsx` renders the approved sculpted-serif wordmark
from `src/assets/brand/yuri-wordmark.svg` as a current-color mask. The disconnected
welcome page places it in a safe-area-aware top-left header; the portrait remains
the central decorative mark. `assets/brand/yuri/build_wordmark.py` regenerates the
master artwork and synchronizes this bundled SVG. The welcome's connection/history
actions retain their existing shared sheet and modal behavior.

## Validation

Use `bun run --cwd packages/ui type-check`, `lint`, and `test`.
The `brand-storage-migration.chrome.test.ts` regression uses real Chromium
IndexedDB for Blob copying, transaction abort/retry and non-resurrection. This is
same-origin browser evidence, not proof of Electron cross-origin or native-sandbox
migration. Real shell install/import/relay/OTA acceptance remains required.
