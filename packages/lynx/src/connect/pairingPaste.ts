import {
  parsePairingConnectionPayloadString,
  type PairingConnectionPayload,
} from '../pairing/payload';
import { parseConnectionPayload } from '../pairing/scan';
import { parseDeepLink } from '../deep-links/intents';

export type LynxPairingPasteResult =
  | { status: 'pairing'; pairing: PairingConnectionPayload }
  | { status: 'invalid' }
  | { status: 'empty' };

/**
 * Paste openchamber://connect / raw v2 pairing JSON into redeem path.
 * Camera QR remains a labeled stub at the UI layer.
 */
export function parsePastedPairingLink(raw: string): LynxPairingPasteResult {
  const trimmed = raw.trim();
  if (!trimmed) return { status: 'empty' };

  const fromString = parsePairingConnectionPayloadString(trimmed);
  if (fromString) return { status: 'pairing', pairing: fromString };

  const deep = parseDeepLink(trimmed);
  if (deep?.type === 'connect') {
    return { status: 'pairing', pairing: deep.pairing };
  }

  const scanned = parseConnectionPayload(trimmed);
  if (scanned && 'pairing' in scanned && scanned.pairing) {
    return { status: 'pairing', pairing: scanned.pairing };
  }

  return { status: 'invalid' };
}
