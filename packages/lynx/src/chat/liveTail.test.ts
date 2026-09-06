import { describe, expect, test } from 'vitest';

import {
  applyLynxLivePatch,
  applyNormalizedEventToTimeline,
} from './liveTail';
import { normalizeLynxOpenCodeEvent } from './liveEvents';
import {
  LYNX_COMPOSER_OCCUPANCY_HEIGHT,
  LYNX_IME_OCCUPANCY_CONTRACT,
  resolveLynxComposerOccupancyInset,
} from './imeOccupancy';
import { createEmptyTimelineState } from './timelineModel';

describe('Lynx live tail apply (single list, no overlay)', () => {
  test('folds part deltas into the same timeline entry keys', () => {
    let state = createEmptyTimelineState('ses_1', '/repo');
    state = applyLynxLivePatch(state, {
      kind: 'upsert-message',
      sessionID: 'ses_1',
      messageId: 'msg_1',
      role: 'assistant',
      text: '',
    });
    state = applyLynxLivePatch(state, {
      kind: 'part-delta',
      sessionID: 'ses_1',
      messageId: 'msg_1',
      partID: 'p1',
      field: 'text',
      delta: 'Hel',
    });
    state = applyLynxLivePatch(state, {
      kind: 'part-delta',
      sessionID: 'ses_1',
      messageId: 'msg_1',
      partID: 'p1',
      field: 'text',
      delta: 'lo',
    });
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.key).toBe('msg_1');
    expect(state.entries[0]?.text).toBe('Hello');
  });

  test('session.status busy/idle toggles working and becameIdle', () => {
    let state = createEmptyTimelineState('ses_1');
    const busy = normalizeLynxOpenCodeEvent({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'busy' } },
    });
    expect(busy.action).toBe('emit');
    if (busy.action !== 'emit') return;
    ({ state } = applyNormalizedEventToTimeline(state, busy.event));
    expect(state.sessionIsWorking).toBe(true);

    const idle = normalizeLynxOpenCodeEvent({
      type: 'session.idle',
      properties: { sessionID: 'ses_1' },
    });
    expect(idle.action).toBe('emit');
    if (idle.action !== 'emit') return;
    const applied = applyNormalizedEventToTimeline(state, idle.event);
    expect(applied.state.sessionIsWorking).toBe(false);
    expect(applied.patch).toMatchObject({ kind: 'session-working', becameIdle: true });
  });

  test('ignores events for other sessions (no second live list)', () => {
    const state = createEmptyTimelineState('ses_1');
    const other = normalizeLynxOpenCodeEvent({
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_other',
        messageID: 'm',
        partID: 'p',
        field: 'text',
        delta: 'x',
      },
    });
    expect(other.action).toBe('emit');
    if (other.action !== 'emit') return;
    const applied = applyNormalizedEventToTimeline(state, other.event);
    expect(applied.state.entries).toHaveLength(0);
    expect(applied.patch).toBeNull();
  });
});

describe('IME occupancy contract', () => {
  test('occupancy stays collapsed even when keyboard/expanded are set', () => {
    expect(LYNX_IME_OCCUPANCY_CONTRACT).toMatchObject({
      hostBindsIme: true,
      forbidWebViewFlip: true,
      occupancyIsCollapsedOnly: true,
    });
    expect(resolveLynxComposerOccupancyInset({
      keyboardHeight: 320,
      expanded: true,
    })).toBe(LYNX_COMPOSER_OCCUPANCY_HEIGHT);
    expect(resolveLynxComposerOccupancyInset({
      collapsedHeight: 64,
      accessoryHeight: 8,
      keyboardHeight: 400,
    })).toBe(72);
  });
});
