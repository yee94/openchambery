const PREFLIGHT_CACHE_SECONDS = '600';

export const applyRuntimeCorsHeaders = ({ origin, setHeader }) => {
  setHeader('Access-Control-Allow-Origin', origin);
  setHeader('Access-Control-Allow-Credentials', 'true');
  setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With,Cache-Control,X-OpenCode-Directory,X-OpenCode-Directory-Encoding,X-Message-Queue-Upload-Token,X-Message-Queue-Sha256,X-Message-Queue-Content-Length');
  // Packaged clients (Electron openchamber-ui://app, Capacitor, Vite HMR) are
  // cross-origin to the runtime API. Without an expose list, browsers hide
  // custom response headers from JS — including the optional-read existence
  // marker that FilesAPI.readFile({ optional: true }) requires.
  setHeader('Access-Control-Expose-Headers', 'x-next-cursor, x-openchamber-file-exists');
  setHeader('Access-Control-Max-Age', PREFLIGHT_CACHE_SECONDS);
  setHeader('Vary', 'Origin');
};
