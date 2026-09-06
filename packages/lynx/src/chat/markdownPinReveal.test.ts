import { describe, expect, test } from 'vitest';

import {
  LYNX_MARKDOWN_PIN_SEED_COUNT,
  areLynxMountedRelevantMarkdownRowsReady,
  armLynxMarkdownPinReveal,
  createLynxMarkdownPinRevealState,
  lynxMarkdownPinRevealVisibility,
  markLynxMarkdownPinReady,
  resolveLynxMarkdownPinRevealKeys,
  shouldArmLynxMarkdownPinReveal,
} from './markdownPinReveal';
import { canAcceptLynxLoadOlderTap } from './loadOlder';

describe('lynx markdown pin reveal', () => {
  test('seeds bottom-entering keys like Cap', () => {
    const keys = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const seeded = resolveLynxMarkdownPinRevealKeys({ entryKeys: keys });
    expect(seeded).toHaveLength(LYNX_MARKDOWN_PIN_SEED_COUNT);
    expect(seeded[0]).toBe('m8');
    expect(seeded.at(-1)).toBe('m19');
  });

  test('session-open arms once per scope; jump-to-latest re-arms', () => {
    expect(shouldArmLynxMarkdownPinReveal({
      reason: 'session-open',
      alreadyRevealedForScope: true,
    })).toBe(false);
    expect(shouldArmLynxMarkdownPinReveal({
      reason: 'jump-to-latest',
      alreadyRevealedForScope: true,
    })).toBe(true);
  });

  test('state machine pending → ready; empty transcript ready immediately', () => {
    let state = createLynxMarkdownPinRevealState('ses_1');
    state = armLynxMarkdownPinReveal(state, {
      reason: 'session-open',
      entryKeys: ['a', 'b'],
      scopeKey: 'ses_1',
    });
    expect(state.phase).toBe('pending');
    expect(lynxMarkdownPinRevealVisibility(state.phase)).toBe('hidden');
    state = markLynxMarkdownPinReady(state);
    expect(state.phase).toBe('ready');
    expect(state.alreadyRevealedForScope).toBe(true);

    const empty = armLynxMarkdownPinReveal(createLynxMarkdownPinRevealState('ses_2'), {
      reason: 'session-open',
      entryKeys: [],
      scopeKey: 'ses_2',
    });
    expect(empty.phase).toBe('ready');
  });

  test('mounted relevant readiness matches Cap spirit', () => {
    expect(areLynxMountedRelevantMarkdownRowsReady({
      relevantKeys: ['a', 'b', 'c'],
      mountedKeys: new Set(['b']),
      readyKeys: new Set(['b']),
    })).toBe(true);
    expect(areLynxMountedRelevantMarkdownRowsReady({
      relevantKeys: ['a', 'b'],
      mountedKeys: new Set(['a', 'b']),
      readyKeys: new Set(['a']),
    })).toBe(false);
  });
});

describe('load-older polish', () => {
  test('rejects tap while prepend settling or busy', () => {
    expect(canAcceptLynxLoadOlderTap({
      canLoadEarlier: true,
      isLoadingOlder: false,
      prependSettling: true,
    })).toBe(false);
    expect(canAcceptLynxLoadOlderTap({
      canLoadEarlier: true,
      isLoadingOlder: true,
    })).toBe(false);
    expect(canAcceptLynxLoadOlderTap({
      canLoadEarlier: true,
      isLoadingOlder: false,
      prependSettling: false,
    })).toBe(true);
  });
});
