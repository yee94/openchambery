// Legacy schemes are receive-only aliases; producers continue to emit yuri://.
export const DEEP_LINK_PROTOCOLS = Object.freeze(['yuri', 'openchamber', 'openchambery']);

export const isAppDeepLink = (raw) => {
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw.trim());
    return DEEP_LINK_PROTOCOLS.includes(url.protocol.slice(0, -1)) && Boolean(url.hostname);
  } catch {
    return false;
  }
};
