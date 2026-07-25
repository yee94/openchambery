import { describe, expect, it } from 'vitest';
import { createSessionTurnGate } from './session-turn-gate.js';

describe('session turn gate', () => {
  it('recovers a stable incomplete assistant tail after a bounded idle grace', () => {
    let now = 0; const gate = createSessionTurnGate({ clock: () => now }); const key = 'runtime/session';
    expect(gate.evaluate(key, { available: true, idle: true, tailID: 'assistant', tailRole: 'assistant', tailCompleted: false })).toMatchObject({ ready: false });
    now = 2_999; expect(gate.evaluate(key, { available: true, idle: true, tailID: 'assistant', tailRole: 'assistant', tailCompleted: false })).toMatchObject({ ready: false });
    now = 3_000; expect(gate.evaluate(key, { available: true, idle: true, tailID: 'assistant', tailRole: 'assistant', tailCompleted: false })).toEqual({ ready: true, reason: 'stopped_assistant', nextCheckAt: 3_000 });
  });

  it('uses a longer three-probe grace for an unanswered user tail', () => {
    let now = 0; const gate = createSessionTurnGate({ clock: () => now }); const key = 'runtime/session'; const input = { available: true, idle: true, tailID: 'user', tailRole: 'user', tailCompleted: false };
    expect(gate.evaluate(key, input).ready).toBe(false);
    now = 5_000; expect(gate.evaluate(key, input).ready).toBe(false);
    now = 10_000; expect(gate.evaluate(key, input)).toMatchObject({ ready: true, reason: 'aborted_before_assistant' });
  });

  it('resets stability when the session becomes busy or the tail changes', () => {
    let now = 0; const gate = createSessionTurnGate({ clock: () => now }); const key = 'runtime/session';
    gate.evaluate(key, { available: true, idle: true, tailID: 'old', tailRole: 'assistant', tailCompleted: false });
    now = 3_000; gate.evaluate(key, { available: true, idle: false, tailID: 'old', tailRole: 'assistant', tailCompleted: false });
    expect(gate.evaluate(key, { available: true, idle: true, tailID: 'new', tailRole: 'assistant', tailCompleted: false }).ready).toBe(false);
  });

  it('does not let elapsed time across an unavailable probe satisfy stability', () => {
    let now = 0; const gate = createSessionTurnGate({ clock: () => now }); const key = 'runtime/session'; const tail = { available: true, idle: true, tailID: 'assistant', tailRole: 'assistant', tailCompleted: false };
    gate.evaluate(key, tail);
    now = 3_000; gate.evaluate(key, { ...tail, available: false });
    expect(gate.evaluate(key, tail).ready).toBe(false);
  });

  it('lets client operations invalidate automatic admission without blocking the client', () => {
    let now = 0; const gate = createSessionTurnGate({ clock: () => now }); const key = 'runtime/session';
    gate.evaluate(key, { available: true, idle: true, tailID: null, tailRole: null, tailCompleted: false });
    const token = gate.acquireAutomatic(key); expect(token).not.toBeNull();
    gate.noteClientOperation(key);
    expect(gate.validateAutomatic(token)).toBe(false);
    expect(gate.evaluate(key, { available: true, idle: true, tailID: null, tailRole: null, tailCompleted: false })).toMatchObject({ ready: false, reason: 'client_preempted' });
    now = 2_000;
    expect(gate.evaluate(key, { available: true, idle: true, tailID: null, tailRole: null, tailCompleted: false })).toMatchObject({ ready: true });
  });

  it('keeps unrelated sessions independent and bounds memory', () => {
    let now = 0; const gate = createSessionTurnGate({ clock: () => now, maxEntries: 2, userTailGraceMs: 1 });
    gate.evaluate('a', { available: true, idle: true, tailID: null, tailRole: null, tailCompleted: false });
    now = 2; gate.evaluate('b', { available: true, idle: true, tailID: null, tailRole: null, tailCompleted: false });
    gate.evaluate('c', { available: true, idle: true, tailID: null, tailRole: null, tailCompleted: false });
    expect(gate.size()).toBe(2);
  });
});
