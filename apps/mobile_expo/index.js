/**
 * Track 9 entry — polyfill WebCrypto BEFORE any app/relay modules load.
 * Hermes has no crypto.subtle; relay E2EE (lib/relay/crypto.ts) needs it.
 * Prefer a surgical patch over react-native-quick-crypto install() which
 * replaces global.crypto wholesale.
 */
import { Buffer } from '@craftzdog/react-native-buffer';
import { getRandomValues, subtle } from 'react-native-quick-crypto';

if (typeof globalThis.Buffer === 'undefined') {
  // @ts-expect-error RN buffer shape
  globalThis.Buffer = Buffer;
}

const cryptoObj =
  globalThis.crypto && typeof globalThis.crypto === 'object'
    ? globalThis.crypto
    : {};

if (!cryptoObj.subtle) {
  cryptoObj.subtle = subtle;
}
if (typeof cryptoObj.getRandomValues !== 'function') {
  cryptoObj.getRandomValues = getRandomValues;
}

// @ts-expect-error assign polyfilled crypto
globalThis.crypto = cryptoObj;

import 'expo-router/entry';
