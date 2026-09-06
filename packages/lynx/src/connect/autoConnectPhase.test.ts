import { describe, expect, test } from 'vitest';

import { nextAutoConnectPhase, resolveLynxConnectGate } from './autoConnectPhase';

describe('Lynx auto-connect gate', () => {
  test('splash while attempting, welcome when done unconnected', () => {
    expect(resolveLynxConnectGate({
      phase: 'attempting',
      connected: false,
      autoConnectLabel: 'home-lan',
    })).toEqual({ kind: 'splash', phase: 'attempting', label: 'home-lan' });

    expect(resolveLynxConnectGate({
      phase: 'done',
      connected: false,
    })).toEqual({ kind: 'welcome' });

    expect(resolveLynxConnectGate({
      phase: 'done',
      connected: true,
    })).toEqual({ kind: 'connected' });
  });

  test('phase machine pending → attempting → done', () => {
    expect(nextAutoConnectPhase('pending', 'start')).toBe('attempting');
    expect(nextAutoConnectPhase('attempting', 'finish')).toBe('done');
    expect(nextAutoConnectPhase('done', 'start')).toBe('done');
  });
});
