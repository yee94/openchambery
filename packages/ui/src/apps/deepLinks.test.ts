import { describe, expect, test } from 'bun:test';

import { buildPairingConnectionPayload, encodePairingConnectionPayload } from '@/lib/connectionPayload';

import { buildDeepLink, parseDeepLink } from './deepLinks';

const pairing = buildPairingConnectionPayload({
  pairingId: 'pair_deep_link',
  secret: 'one-time-secret',
  candidates: [{ type: 'lan', url: 'http://192.168.1.20:4096' }],
});

describe('parseDeepLink (OpenCode-aligned)', () => {
  test('parses a v2 connect link into a validated pairing intent', () => {
    expect(parseDeepLink(encodePairingConnectionPayload(pairing))).toEqual({
      type: 'connect',
      pairing,
    });
  });

  test('rejects malformed and legacy connect links', () => {
    expect(parseDeepLink('openchamber://connect?v=2&p=not-json')).toBeNull();
    expect(parseDeepLink('openchamber://connect?v=1&server=https%3A%2F%2Fexample.com&token=secret')).toBeNull();
  });

  test('parses new-session with directory query like OpenCode', () => {
    expect(parseDeepLink('openchamber://new-session?directory=/tmp/demo')).toEqual({
      type: 'new-session',
      directory: '/tmp/demo',
      projectId: undefined,
      agent: undefined,
      model: undefined,
      prompt: undefined,
    });
  });

  test('parses new-session with optional prompt', () => {
    expect(parseDeepLink('openchamber://new-session?directory=/tmp/demo&prompt=hello%20world')).toEqual({
      type: 'new-session',
      directory: '/tmp/demo',
      projectId: undefined,
      agent: undefined,
      model: undefined,
      prompt: 'hello world',
    });
  });

  test('accepts legacy dir= and CodeX-style path= aliases', () => {
    const legacy = parseDeepLink('openchamber://new-session?dir=/legacy');
    expect(legacy?.type === 'new-session' ? legacy.directory : undefined).toBe('/legacy');
    const codexStyle = parseDeepLink('openchamber://new-session?path=/codex');
    expect(codexStyle?.type === 'new-session' ? codexStyle.directory : undefined).toBe('/codex');
  });

  test('parses open-project?directory= like OpenCode', () => {
    expect(parseDeepLink('openchamber://open-project?directory=/tmp/demo')).toEqual({
      type: 'open-project',
      directory: '/tmp/demo',
    });
  });

  test('parses legacy project/<path> form', () => {
    expect(parseDeepLink('openchamber://project/%2Ftmp%2Fdemo')).toEqual({
      type: 'open-project',
      directory: '/tmp/demo',
    });
  });

  test('ignores open-project without a directory', () => {
    expect(parseDeepLink('openchamber://open-project')).toBeNull();
    expect(parseDeepLink('openchamber://open-project?directory=')).toBeNull();
  });
});

describe('buildDeepLink (OpenCode-aligned)', () => {
  test('rebuilds a canonical v2 connect link', () => {
    expect(buildDeepLink({ type: 'connect', pairing })).toBe(encodePairingConnectionPayload(pairing));
  });

  test('emits new-session?directory= for external openers', () => {
    expect(buildDeepLink({ type: 'new-session', directory: '/tmp/demo', prompt: 'ship it' })).toBe(
      'openchamber://new-session?directory=%2Ftmp%2Fdemo&prompt=ship+it',
    );
  });

  test('emits open-project?directory=', () => {
    expect(buildDeepLink({ type: 'open-project', directory: '/tmp/demo' })).toBe(
      'openchamber://open-project?directory=%2Ftmp%2Fdemo',
    );
  });
});
