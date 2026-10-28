/** Only application documents, never same-origin preview/API pages, get native GUI IPC. */
export function isGuiPluginUiUrl(raw, origins) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    const packaged = url.protocol === 'yuri-ui:' && url.host === 'app';
    if (!packaged && (!['http:', 'https:'].includes(url.protocol) || !origins.some((origin) => {
      try { return new URL(origin).origin === url.origin; } catch { return false; }
    }))) return false;
    return ['/', '/index.html', '/mini-chat.html', '/mobile.html', '/connect', '/new'].includes(url.pathname)
      || /^\/(session|settings|assistant|schedule)(\/|$)/.test(url.pathname);
  } catch { return false; }
}
