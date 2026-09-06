import {
  parsePairingConnectionPayload,
  type PairingConnectionPayload,
} from './payload';

export type LynxConnectionPayload = {
  url: string;
  clientToken?: string;
  label?: string;
};

export type LynxPairingPayload = {
  pairing: PairingConnectionPayload;
};

/**
 * QR / paste parser. Accepts a pairing v2 `openchamber://connect?v=2&p=` link
 * or a bare http(s) server URL. Legacy v1 token links and other schemes are
 * rejected — there is no Nearby / Bonjour browse path.
 */
export const parseConnectionPayload = (
  raw: string,
  nowMs: number = Date.now(),
): LynxConnectionPayload | LynxPairingPayload | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^openchamber:\/\//i.test(trimmed)) {
    const pairing = parsePairingConnectionPayload(trimmed, nowMs);
    return pairing ? { pairing } : null;
  }

  if (/^https?:\/\//i.test(trimmed)) return { url: trimmed };
  return null;
};
