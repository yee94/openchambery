import { describe, expect, test } from 'vitest';

import {
  LYNX_ASSISTANT_SHARE_WELCOME_STORAGE_KEY,
  LYNX_SHARE_WELCOME_EXAMPLES,
  createLynxShareWelcomeStore,
  resolveLynxShareWelcomeOpen,
  createLynxShareWelcomeState,
  dismissLynxShareWelcome,
} from './shareWelcome';

describe('Lynx share welcome', () => {
  test('auto-opens once when enabled and not dismissed (Cap spirit)', () => {
    const state = createLynxShareWelcomeState(false);
    expect(resolveLynxShareWelcomeOpen(state, { enabled: true })).toBe(true);
    expect(resolveLynxShareWelcomeOpen(state, { enabled: false })).toBe(false);
    const dismissed = dismissLynxShareWelcome(state);
    expect(resolveLynxShareWelcomeOpen(dismissed, { enabled: true })).toBe(false);
  });

  test('store persists Cap storage key constant and controlled reopen', () => {
    expect(LYNX_ASSISTANT_SHARE_WELCOME_STORAGE_KEY).toBe('openchamber:assistant-share-welcome:v1');
    expect(LYNX_SHARE_WELCOME_EXAMPLES).toHaveLength(3);
    const store = createLynxShareWelcomeStore(false);
    expect(store.isOpen(true)).toBe(true);
    store.dismiss();
    expect(store.shouldPersistDismissed()).toBe(true);
    expect(store.isOpen(true)).toBe(false);
    store.open();
    expect(store.isOpen(true)).toBe(true);
  });
});
