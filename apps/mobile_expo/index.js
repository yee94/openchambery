/**
 * Track 9 entry — polyfill WebCrypto BEFORE any app/relay modules load.
 * Hermes has no crypto.subtle; relay E2EE (lib/relay/crypto.ts) needs it at import time.
 */
import { install as installQuickCrypto } from 'react-native-quick-crypto';

installQuickCrypto();

import 'expo-router/entry';
