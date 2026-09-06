/**
 * QR / paste parse for connect. Camera is a host adapter — this module only
 * interprets the raw string. No Nearby / Bonjour browse.
 */

import { parsePairingConnectionPayload } from './pairing.ts';
import type { LynxConnectError, LynxPairingConnectionPayload } from './types.ts';

export type LynxConnectionPayload =
  | { kind: 'url'; url: string; clientToken?: string; label?: string }
  | { kind: 'pairing'; pairing: LynxPairingConnectionPayload };

export type LynxQrParseResult =
  | ({ status: 'ok' } & Extract<LynxConnectionPayload, { kind: 'url' }>)
  | ({ status: 'pairing' } & Extract<LynxConnectionPayload, { kind: 'pairing' }>)
  | { status: 'invalid' };

export const parseConnectionPayload = (raw: string): LynxConnectionPayload | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^openchamber:\/\//i.test(trimmed)) {
    const pairing = parsePairingConnectionPayload(trimmed);
    return pairing ? { kind: 'pairing', pairing } : null;
  }

  if (/^https?:\/\//i.test(trimmed)) return { kind: 'url', url: trimmed };
  return null;
};

export const resultFromQrRaw = (raw: string): LynxQrParseResult => {
  const payload = parseConnectionPayload(raw);
  if (!payload) return { status: 'invalid' };
  if (payload.kind === 'pairing') return { status: 'pairing', ...payload };
  return { status: 'ok', ...payload };
};

export const qrScanStatusToError = (
  status: 'permission-denied' | 'unsupported' | 'failed' | 'invalid',
): LynxConnectError => {
  if (status === 'permission-denied') return 'scan-permission-denied';
  if (status === 'unsupported') return 'scan-unsupported';
  if (status === 'failed') return 'scan-failed';
  return 'scan-invalid';
};
