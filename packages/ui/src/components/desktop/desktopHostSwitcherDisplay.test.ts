import { describe, expect, test } from 'bun:test';
import {
  resolveHostRowDisplay,
  sshPhaseToHostDisplayStatus,
} from './desktopHostSwitcherDisplay';

describe('resolveHostRowDisplay', () => {
  test('active + connected => ok even when probe is missing', () => {
    const display = resolveHostRowDisplay({
      isActive: true,
      isSsh: false,
      runtimeIsConnected: true,
      runtimeConnectionPhase: 'connected',
      currentTransportIsRelay: false,
      probe: null,
      sshPhase: undefined,
    });
    expect(display.statusKind).toBe('ok');
    expect(display.showViaRelay).toBe(false);
    expect(display.latencyMs).toBeNull();
  });

  test('active + connecting => checking even when stale probe is ok', () => {
    const display = resolveHostRowDisplay({
      isActive: true,
      isSsh: false,
      runtimeIsConnected: false,
      runtimeConnectionPhase: 'connecting',
      currentTransportIsRelay: false,
      probe: { status: 'ok', latencyMs: 12 },
      sshPhase: undefined,
    });
    expect(display.statusKind).toBe('checking');
    expect(display.latencyMs).toBeNull();
  });

  test('inactive keeps probe status', () => {
    const display = resolveHostRowDisplay({
      isActive: false,
      isSsh: false,
      runtimeIsConnected: true,
      runtimeConnectionPhase: 'connected',
      currentTransportIsRelay: false,
      probe: { status: 'unreachable', latencyMs: 0 },
      sshPhase: undefined,
    });
    expect(display.statusKind).toBe('unreachable');
    expect(display.showViaRelay).toBe(false);
    expect(display.latencyMs).toBeNull();
  });

  test('active Relay only shows latency when probe is also relay', () => {
    const withRelayProbe = resolveHostRowDisplay({
      isActive: true,
      isSsh: false,
      runtimeIsConnected: true,
      runtimeConnectionPhase: 'connected',
      currentTransportIsRelay: true,
      probe: { status: 'ok', latencyMs: 42, via: 'relay' },
      sshPhase: undefined,
    });
    expect(withRelayProbe.statusKind).toBe('ok');
    expect(withRelayProbe.showViaRelay).toBe(true);
    expect(withRelayProbe.latencyMs).toBe(42);

    const withDirectProbe = resolveHostRowDisplay({
      isActive: true,
      isSsh: false,
      runtimeIsConnected: true,
      runtimeConnectionPhase: 'connected',
      currentTransportIsRelay: true,
      probe: { status: 'ok', latencyMs: 8 },
      sshPhase: undefined,
    });
    expect(withDirectProbe.statusKind).toBe('ok');
    expect(withDirectProbe.showViaRelay).toBe(true);
    expect(withDirectProbe.latencyMs).toBeNull();
  });

  test('active direct only shows latency when probe is direct', () => {
    const withDirectProbe = resolveHostRowDisplay({
      isActive: true,
      isSsh: false,
      runtimeIsConnected: true,
      runtimeConnectionPhase: 'connected',
      currentTransportIsRelay: false,
      probe: { status: 'ok', latencyMs: 15 },
      sshPhase: undefined,
    });
    expect(withDirectProbe.statusKind).toBe('ok');
    expect(withDirectProbe.showViaRelay).toBe(false);
    expect(withDirectProbe.latencyMs).toBe(15);

    const withRelayProbe = resolveHostRowDisplay({
      isActive: true,
      isSsh: false,
      runtimeIsConnected: true,
      runtimeConnectionPhase: 'connected',
      currentTransportIsRelay: false,
      probe: { status: 'ok', latencyMs: 99, via: 'relay' },
      sshPhase: undefined,
    });
    expect(withRelayProbe.statusKind).toBe('ok');
    expect(withRelayProbe.showViaRelay).toBe(false);
    expect(withRelayProbe.latencyMs).toBeNull();
  });

  test('inactive may show its own real probe latency', () => {
    const direct = resolveHostRowDisplay({
      isActive: false,
      isSsh: false,
      runtimeIsConnected: true,
      runtimeConnectionPhase: 'connected',
      currentTransportIsRelay: true,
      probe: { status: 'ok', latencyMs: 21 },
      sshPhase: undefined,
    });
    expect(direct.statusKind).toBe('ok');
    expect(direct.showViaRelay).toBe(false);
    expect(direct.latencyMs).toBe(21);

    const relay = resolveHostRowDisplay({
      isActive: false,
      isSsh: false,
      runtimeIsConnected: true,
      runtimeConnectionPhase: 'connected',
      currentTransportIsRelay: false,
      probe: { status: 'ok', latencyMs: 77, via: 'relay' },
      sshPhase: undefined,
    });
    expect(relay.statusKind).toBe('ok');
    expect(relay.showViaRelay).toBe(true);
    expect(relay.latencyMs).toBe(77);
  });

  test('inactive SSH uses phase mapping; no probe latency', () => {
    const ready = resolveHostRowDisplay({
      isActive: false,
      isSsh: true,
      runtimeIsConnected: false,
      runtimeConnectionPhase: 'connecting',
      currentTransportIsRelay: false,
      probe: { status: 'ok', latencyMs: 5 },
      sshPhase: 'ready',
    });
    expect(ready.statusKind).toBe('ok');
    expect(ready.latencyMs).toBeNull();
    expect(ready.showViaRelay).toBe(false);

    const connecting = resolveHostRowDisplay({
      isActive: false,
      isSsh: true,
      runtimeIsConnected: false,
      runtimeConnectionPhase: 'connecting',
      currentTransportIsRelay: false,
      probe: null,
      sshPhase: 'master_connecting',
    });
    expect(connecting.statusKind).toBe('auth');

    const errored = resolveHostRowDisplay({
      isActive: false,
      isSsh: true,
      runtimeIsConnected: false,
      runtimeConnectionPhase: 'connecting',
      currentTransportIsRelay: false,
      probe: null,
      sshPhase: 'error',
    });
    expect(errored.statusKind).toBe('unreachable');
  });

  test('active SSH still uses runtime connection, not SSH phase or probe', () => {
    const display = resolveHostRowDisplay({
      isActive: true,
      isSsh: true,
      runtimeIsConnected: true,
      runtimeConnectionPhase: 'connected',
      currentTransportIsRelay: false,
      probe: { status: 'unreachable', latencyMs: 0 },
      sshPhase: 'error',
    });
    expect(display.statusKind).toBe('ok');
    expect(display.latencyMs).toBeNull();
  });
});

describe('sshPhaseToHostDisplayStatus', () => {
  test('maps idle/ready/error and in-progress phases', () => {
    expect(sshPhaseToHostDisplayStatus(undefined)).toBeNull();
    expect(sshPhaseToHostDisplayStatus('idle')).toBeNull();
    expect(sshPhaseToHostDisplayStatus('ready')).toBe('ok');
    expect(sshPhaseToHostDisplayStatus('error')).toBe('unreachable');
    expect(sshPhaseToHostDisplayStatus('forwarding')).toBe('auth');
  });
});
