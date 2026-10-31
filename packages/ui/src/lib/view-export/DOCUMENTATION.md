# Client view export / Yuri GSAPI v1

Two independent GUI contracts use the official `Contract.define` / `ctx.use` extension mechanism:

- `yuri.exportPDF`: `ExportPDFAPI` (`version: 1`, `limits`, `exportPDF(input, options)`).
- `yuri.exportLongImage`: `ExportLongImageAPI` (`version: 1`, `limits`, `exportLongImage(input, options)`).

Types in `types.ts` are the wire and window contract. Plugins declare the structural types with the official SDK; no new module import or altered OpenCode client is required. These names are reserved to the host. Only an available native implementation activates each contract. Plain web, hosted mobile, VS Code and older shells report unsupported; no fake successful downloads.

The capability belongs to the current client device, independently of its connected OpenCode instance and LAN/Relay transport. It is not plugin `main` IPC and never grants native code execution. Existing native-plugin gates remain intact.

```ts
import { Contract } from '@opencode/plugin/gui';
// ExportPDFAPI is the structural interface documented in types.ts.
const PDF = Contract.define<ExportPDFAPI, 'yuri.exportPDF'>('yuri.exportPDF');
const pdf = ctx.use(PDF);

// In a user-triggered action, with a controller owned by the current view:
const current = pdf();
if (current.status === 'active') {
    await current.value.exportPDF({ snapshot, filename: 'report.pdf', pageSize: 'a4' }, {
        signal: controller.signal,
        onProgress,
    }).then(result => result.status === 'saved' ? onSuccess() : onCancel(), onError);
}
```

`yuri.exportLongImage` uses its own `ExportLongImageAPI.exportLongImage` method
and has no PDF page-size option. Neither public method takes a format switch.
Success/error/cancel handling is Promise-based; only progress is a repeated
callback. Once a native write has committed, its `saved` result is authoritative
even if an abort arrives concurrently. A closed view ignores UI updates.

## Snapshot and native protocol

Callers capture their own live DOM (including iframe content from within that iframe) into `{ html, width, height }`: a static self-contained HTML fragment, inline styles and data assets. No remote URL, arbitrary file path or JavaScript execution. Each renderer must enforce an isolated document, disable scripts/network/navigation, and bound resources independently of UI checks. Shared transport ceilings: HTML UTF-8 100 MiB, width 8192 CSS px, height 32768 CSS px, total 16,777,216 pixels. Effective limits are the minimum of these ceilings and native capabilities. Electron and Android advertise 16 MiB HTML; iOS advertises 100 MiB HTML, width 2048 CSS px, height 32768 CSS px and 8,388,608 pixels. PNG is at one output pixel per CSS pixel. PDF defaults to paginated A4, with optional Letter.

PDF uses 24-point margins on every side and 96 CSS pixels per inch (72 PDF
points per inch). Narrow content is not enlarged; wider content is scaled down
to fit the available page width. Pagination uses the remaining page height.
Text and vectors use native PDF rendering rather than a screenshot-only PDF.

Native methods are `capabilities`, `exportPDF`, `exportLongImage`, `cancel`. Export inputs add `taskId`; `cancel` receives `{ taskId }`. Progress events contain `taskId`, `stage` (`preparing`, `rendering`, `encoding`, `saving`) and optional `completed` / `total`. Success resolves `{ status: 'saved' }` only after file writing finishes; user/owner cancellation resolves `{ status: 'cancelled' }`; failure rejects with a stable `EXPORT_*` code. Native methods correlate events to tasks and release renderer/temp files on completion, failure, cancellation, navigation and teardown. No callback functions or AbortSignal cross IPC.

Electron exposes `viewExport.request(method, input)` with `ViewExportReply` and `viewExport.subscribe(listener)` on the existing preload bridge. The main process permits only the owned app main-frame document (including its remote-runtime/window-only mode), never remote documents, filesystem/preview routes or iframes. A native save dialog chooses destination; renderer inputs cannot choose a host path.

Capacitor registers `YuriViewExport`: methods above with native Promise results, plus `progress` events. iOS/Android save PNG to Photos/the gallery and PDF through a native document picker; HTML's `ctx.system.save` remains a file save. Generated image files stay native, without multi-megabyte base64 crossing JS. iOS requests add-only Photos access; Android 10+ publishes through MediaStore (`Pictures/Yuri`), while Android 7–9 requests storage-write permission. Denial or write failure rejects with `EXPORT_SAVE_FAILED`, never silently switches the image to Files. Failed/cancelled Android writes remove the pending entry. An in-flight Photos transaction retains its file and busy slot until completion, with committed `saved` winning over late cancellation. Native builds are required for this destination change; an OTA cannot replace an installed exporter. One export per native owner is allowed; concurrent requests return `EXPORT_BUSY`.

The window wrapper owns task IDs, subscribes before starting, forwards abort, filters late events, and clears listeners. GUI wrappers bind tasks to plugin lifetime; replacing/disabling the plugin or switching runtime cancels outstanding work. Panel consumers bind their own view lifetime through `options.signal`, cancelling when closed or replaced. Stage progress is indeterminate unless the underlying work has a real total; no estimated percentages.

## Design references

The reviewed APIs expose image and PDF separately: [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents), [Apple WKWebView](https://developer.apple.com/documentation/webkit/wkwebview), and [Android WebView](https://developer.android.com/reference/android/webkit/WebView). [W3C WebDriver](https://www.w3.org/TR/webdriver2/#screen-capture) standardizes automation screenshot/print commands, not a universally available web-page export API. `yuri.*` is a product-owned namespace, using [OpenCode's public Contract extension](https://opencode.ai/v2/docs/build/plugins/gui#contracts-and-tokens), not a claimed industry standard.

## Work budget

No capture, native import, progress listener or capability query runs on ordinary render. The GUI probes once on first contract use; an explicit export performs one bounded input-size validation, subscribes to its task only, and sends one snapshot. There is no report-content cache or polling. Native rendering and final image allocation remain bounded by the advertised pixel limit; tiled capture does not remove the final bitmap allocation. Progress must not subscribe the app shell or composer to export state. Tests exercise 50 unrelated host updates with unchanged accessor/value and a single probe.

## Validation surfaces

- `api.test.ts`: separate methods, native method availability, payload limits, task-filtered progress, cancellation and listener cleanup.
- `gui-plugins/view-export.test.ts`: actual SDK Contract accessors, independent capability state, namespace ownership, unchanged OpenCode client, per-plugin cancellation and late probe fencing.
- `desktopRelayRouting.integration.test.ts`: device export remains available after a Relay runtime switch while native plugin main access is withdrawn.
- Electron `view-export.test.mjs` and `scripts/view-export-evidence.test.mjs`: native authorization, save/rollback/cancel and real Electron rendering through production preload on HMR/packaged origins.
- Mobile `test/view-export-{ios,android}.test.mjs`: native request validation and opt-in platform execution; see the mobile README for prerequisites.

Chromium integration with the independent Eficy bundle exercised desktop and
390px touch layouts, per-format visibility, real report snapshot capture,
progress/success/error/cancel, view-close cancellation and unsupported shells.
Its container responses were controlled fixtures, not real mobile file saves.
The resulting 373×5878 report snapshot was also rendered by the production
Electron exporter into PNG and a six-page A4 PDF; PDFKit found the complete
footer text. This evidence does not substitute for physical-device picker tests.

The iOS simulator also executes the production WebKit renderer and Capacitor
bridge. WebKit's PDF font mapping may encode some Chinese glyphs as radical
code points (for example `口` as `⼝`), including in the unprocessed native PDF.
Visual output is preserved, but exact searches for affected words can differ;
PDF validation records raw text as well as normalized footer evidence.
