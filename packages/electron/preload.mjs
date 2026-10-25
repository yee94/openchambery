import { contextBridge, ipcRenderer, webUtils } from 'electron';

const eventListeners = new Map();

const readArgValue = (name) => {
  const prefix = `${name}=`;
  const entry = process.argv.find((value) => typeof value === 'string' && value.startsWith(prefix));
  if (!entry) {
    return '';
  }
  return entry.slice(prefix.length);
};

const localOrigin = readArgValue('--yuri-local-origin');
const apiBaseUrl = readArgValue('--yuri-api-base-url');
const clientToken = readArgValue('--yuri-client-token');
const runtimeHeadersRaw = readArgValue('--yuri-runtime-headers');
const homeDirectory = readArgValue('--yuri-home');
const macosMajorRaw = readArgValue('--yuri-macos-major');
const macosMajor = Number.parseInt(macosMajorRaw, 10);
const isPackaged = readArgValue('--yuri-packaged') === '1';
const macVibrancySupported = process.platform === 'darwin';
// Effective state for this window (main process resolves the saved preference
// and passes it in). Defaults on when supported unless explicitly '0'.
const hasMacVibrancy = macVibrancySupported && readArgValue('--yuri-mac-vibrancy') !== '0';
// Boot outcome must be available synchronously at document start so the
// renderer splash gate does not race executeJavaScript(initScript). contextBridge
// values are read-only, so keep a mutable holder and expose a getter; main can
// push updates over IPC after hosts_set / host switch.
const bootOutcomeRaw = readArgValue('--yuri-boot-outcome');
let bootOutcomeState = null;
if (bootOutcomeRaw) {
  try {
    const parsed = JSON.parse(bootOutcomeRaw);
    if (parsed && typeof parsed === 'object') {
      bootOutcomeState = parsed;
    }
  } catch {
    // Malformed argv is treated as not-injected; initScript may still recover.
  }
}

// Preload re-executes on every cross-origin navigation (we run with
// sandbox:false, per-document). Two separate concerns to balance:
//  - __YURI_ELECTRON__ is a shell-identity flag (no capability).
//    Remote UIs still need it so isDesktopShell() returns true and the
//    window renders with desktop affordances (DesktopHostSwitcher,
//    title bar offsets, etc.). Expose unconditionally.
//  - __YURI_DESKTOP__ is the IPC channel to the main process. It is
//    exposed broadly, but privileged commands are gated in main.mjs.
//    Local-only globals below stay limited to packaged UI / exact localOrigin.
// Everything driven by localOrigin (home dir, macOS hints) also stays
// local-only since it leaks info about the Electron host machine.
const currentOrigin = (() => {
  try {
    return typeof location !== 'undefined' ? location.origin : '';
  } catch {
    return '';
  }
})();
// Custom schemes report location.origin as the string "null". Detect packaged
// UI via protocol/hostname instead so client token / home stay local-only.
const isPackagedUiPage = (() => {
  try {
    return typeof location !== 'undefined'
      && location.protocol === 'yuri-ui:'
      && (location.hostname === 'app' || location.host === 'app');
  } catch {
    return false;
  }
})();
const isLocalPage = isPackagedUiPage
  || (Boolean(currentOrigin)
    && currentOrigin !== 'null'
    && Boolean(localOrigin)
    && currentOrigin === localOrigin);

// Remote pages need __YURI_LOCAL_ORIGIN__ so the HostSwitcher knows
// the URL of the Local entry (isDesktopLocalOriginActive() falls back to
// window.location.origin otherwise — wrong on remote). Low risk: the value
// is just "http://127.0.0.1:<port>" which is not exploitable without the
// IPC channel, and CORS on the local server prevents remote-origin fetches.
if (localOrigin) {
  contextBridge.exposeInMainWorld('__YURI_LOCAL_ORIGIN__', localOrigin);
}

if (apiBaseUrl) {
  contextBridge.exposeInMainWorld('__YURI_API_BASE_URL__', apiBaseUrl);
}

if (clientToken && isLocalPage) {
  contextBridge.exposeInMainWorld('__YURI_CLIENT_TOKEN__', clientToken);
}

// Which saved host this window should connect to over the relay-capable path
// (direct probe first, E2EE tunnel fallback). Local pages only — the id is
// only useful together with the desktop IPC channel anyway.
const relayHostId = readArgValue('--yuri-relay-host-id');
if (relayHostId && isLocalPage) {
  contextBridge.exposeInMainWorld('__YURI_RELAY_HOST_ID__', relayHostId);
}

if (runtimeHeadersRaw && isLocalPage) {
  try {
    const runtimeHeaders = JSON.parse(runtimeHeadersRaw);
    if (runtimeHeaders && typeof runtimeHeaders === 'object') {
      contextBridge.exposeInMainWorld('__YURI_RUNTIME_HEADERS__', runtimeHeaders);
    }
  } catch {
  }
}

// Home directory leaks the OS username — keep local-only. Remote pages
// operate on the REMOTE server's filesystem, local home is irrelevant
// (and would be misleading if consumed as a workspace hint).
if (isLocalPage && homeDirectory) {
  contextBridge.exposeInMainWorld('__YURI_HOME__', homeDirectory);
}

// macOS major version drives window chrome offsets (traffic lights) — UI
// presentation only, safe to expose.
if (Number.isFinite(macosMajor) && macosMajor > 0) {
  contextBridge.exposeInMainWorld('__YURI_MACOS_MAJOR__', macosMajor);
}

contextBridge.exposeInMainWorld('__YURI_ELECTRON__', {
  runtime: 'electron',
  packaged: isPackaged,
  macVibrancy: hasMacVibrancy,
  macVibrancySupported,
});

contextBridge.exposeInMainWorld('__YURI_PLATFORM__', process.platform);

// Synchronous boot-outcome getter (see bootOutcomeState above). Main may also
// write window.__YURI_DESKTOP_BOOT_OUTCOME__ via initScript for hosts
// that re-navigate; desktopBoot prefers that global when present.
contextBridge.exposeInMainWorld('__YURI_DESKTOP_BOOT__', {
  getOutcome: () => bootOutcomeState,
});
ipcRenderer.on('yuri:boot-outcome', (_event, outcome) => {
  if (outcome && typeof outcome === 'object') {
    bootOutcomeState = outcome;
  } else if (outcome === null) {
    bootOutcomeState = null;
  }
});

const addListener = (event, handler) => {
  const listeners = eventListeners.get(event) || new Set();
  listeners.add(handler);
  eventListeners.set(event, listeners);

  return () => {
    const current = eventListeners.get(event);
    if (!current) {
      return;
    }
    current.delete(handler);
    if (current.size === 0) {
      eventListeners.delete(event);
    }
  };
};

const dispatchNativeEvent = (event, detail) => {
  const listeners = eventListeners.get(event);
  if (listeners) {
    for (const listener of listeners) {
      try {
        listener({ payload: detail });
      } catch (error) {
        console.error(`[electron:preload] listener failed for ${event}:`, error);
      }
    }
  }

  try {
    const domEvent = detail === undefined
      ? new Event(event)
      : new CustomEvent(event, { detail });
    window.dispatchEvent(domEvent);
  } catch (error) {
    console.error(`[electron:preload] failed to dispatch DOM event ${event}:`, error);
  }
};

// Toggles the frost on/off in response to the main process around the
// minimize/restore cycle. The default ("ready") state is set reliably in the
// renderer (cssGenerator) — not here — because this preload runs at
// document-start when documentElement may not exist yet.
const setVibrancyReady = (ready) => {
  if (!hasMacVibrancy) return;
  try {
    document.documentElement.toggleAttribute('data-yuri-vibrancy-ready', ready === true);
  } catch {
  }
};

// Main-process events are read-only notifications (update progress,
// window focus, etc.) — safe to deliver to any page rendered in this
// webContents. The events themselves don't grant capability.
ipcRenderer.on('yuri:emit', (_evt, payload) => {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const event = typeof payload.event === 'string' ? payload.event : '';
  if (!event) {
    return;
  }

  if (event === 'yuri:vibrancy-ready') {
    setVibrancyReady(payload.detail?.ready === true);
    document.documentElement?.toggleAttribute('data-yuri-vibrancy-suppressed', payload.detail?.suppressed === true);
  }

  dispatchNativeEvent(event, payload.detail);
});

// Virtual image asset bridge — local packaged/HMR UI only. Main still re-checks
// isLocalSender; remote pages must not see these methods.
const virtualAssetApi = isLocalPage
  ? {
      create: (options) => ipcRenderer.invoke('yuri:asset:create', options || {}),
      push: (assetId, chunk) => ipcRenderer.invoke('yuri:asset:push', { assetId, chunk }),
      finish: (assetId) => ipcRenderer.invoke('yuri:asset:finish', { assetId }),
      cancel: (assetId) => ipcRenderer.invoke('yuri:asset:cancel', { assetId }),
    }
  : undefined;

const imageCacheApi = isLocalPage ? {
  acquire: (input) => ipcRenderer.invoke('yuri:image-cache:acquire', input),
  append: (leaseId, chunk) => ipcRenderer.invoke('yuri:image-cache:append', { leaseId, chunk }),
  commit: (leaseId, mime) => ipcRenderer.invoke('yuri:image-cache:commit', { leaseId, mime }),
  release: (leaseId) => ipcRenderer.invoke('yuri:image-cache:release', { leaseId }),
  clear: () => ipcRenderer.invoke('yuri:image-cache:clear'),
  fileResources: true,
  lookup: (input) => ipcRenderer.invoke('yuri:image-cache:lookup', input),
} : undefined;

// Preview loopback gateway — local packaged/HMR UI only. Unauthenticated
// 127.0.0.1 front door; owner renderer runtimeFetchs / openRuntimeWebSockets
// /api/preview/proxy/* (HTTP + HMR WS). Not on COMMANDS_SAFE_FOR_REMOTE.
// Main re-checks isLocalSender.
const previewGatewayApi = isLocalPage
  ? {
      ensure: () => ipcRenderer.invoke('yuri:preview-gateway:ensure'),
      release: () => ipcRenderer.invoke('yuri:preview-gateway:release'),
      begin: (payload) => ipcRenderer.invoke('yuri:preview-gateway:begin', payload || {}),
      push: (requestId, chunk) => ipcRenderer.invoke('yuri:preview-gateway:push', { requestId, chunk }),
      end: (requestId) => ipcRenderer.invoke('yuri:preview-gateway:end', { requestId }),
      abort: (requestId) => ipcRenderer.invoke('yuri:preview-gateway:abort', { requestId }),
      wsOpened: (payload) => ipcRenderer.invoke('yuri:preview-gateway:ws-opened', payload || {}),
      wsSend: (requestId, data, binary) => ipcRenderer.invoke('yuri:preview-gateway:ws-send', {
        requestId,
        data,
        binary: binary === true,
      }),
      wsClose: (requestId, payload) => ipcRenderer.invoke('yuri:preview-gateway:ws-close', {
        requestId,
        ...(payload && typeof payload === 'object' ? payload : {}),
      }),
    }
  : undefined;

// The desktop bridge is exposed on all pages; the main-process gate in
// ipcMain.handle('yuri:invoke') decides per-command what is safe
// for non-local callers (window/host-switcher ops yes, file/shell ops
// no). See COMMANDS_SAFE_FOR_REMOTE in main.mjs.
contextBridge.exposeInMainWorld('__YURI_DESKTOP__', {
  applicationId: readArgValue('--yuri-application-id'),
  shellApiVersion: 2,
  invoke: (cmd, args) => ipcRenderer.invoke('yuri:invoke', cmd, args || {}),
  openDialog: (options) => ipcRenderer.invoke('yuri:dialog:open', options || {}),
  grantFileAccess: (filePath) => ipcRenderer.invoke('yuri:file:grant-existing', filePath),
  getPathForFile: isLocalPage ? (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  } : undefined,
  openExternal: (url) => ipcRenderer.invoke('yuri:invoke', 'desktop_open_external_url', { url }),
  listen: async (event, handler) => addListener(event, handler),
  // Opaque virtual image stream for relay/host-backed images. URL scheme is
  // yuri-asset://stream/<assetId> — never host paths or credentials.
  virtualAsset: virtualAssetApi,
  imageCache: imageCacheApi,
  // Relay Preview iframe origin (http://127.0.0.1:<ephemeral>). Local page only.
  previewGateway: previewGatewayApi,
});
