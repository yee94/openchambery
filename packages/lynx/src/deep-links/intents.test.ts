import { describe, expect, test } from 'vitest';

import { buildPairingConnectionPayload, encodePairingConnectionPayload } from '../pairing/payload';
import { buildDeepLink, parseDeepLink } from './intents';

const pairing = buildPairingConnectionPayload({
  pairingId: 'pair_deep_link',
  secret: 'one-time-secret',
  candidates: [{ type: 'lan', url: 'http://192.168.1.20:4096' }],
});

describe('parseDeepLink', () => {
  test('parses a v2 connect link and rejects v1', () => {
    expect(parseDeepLink(encodePairingConnectionPayload(pairing))).toEqual({ type: 'connect', pairing });
    expect(parseDeepLink('openchamber://connect?v=2&p=not-json')).toBeNull();
    expect(parseDeepLink('openchamber://connect?v=1&server=https%3A%2F%2Fexample.com&token=secret')).toBeNull();
  });

  test('parses session, new-session, open-project, and sessions filters', () => {
    expect(parseDeepLink('openchamber://session/ses_1?directory=/tmp/demo')).toEqual({
      type: 'session',
      sessionId: 'ses_1',
      directory: '/tmp/demo',
    });
    expect(parseDeepLink('openchamber://new-session?directory=/tmp/demo&prompt=hello%20world')).toEqual({
      type: 'new-session',
      directory: '/tmp/demo',
      projectId: undefined,
      agent: undefined,
      model: undefined,
      prompt: 'hello world',
    });
    expect(parseDeepLink('openchamber://open-project?directory=/tmp/demo')).toEqual({
      type: 'open-project',
      directory: '/tmp/demo',
    });
    expect(parseDeepLink('openchamber://project/%2Ftmp%2Fdemo')).toEqual({
      type: 'open-project',
      directory: '/tmp/demo',
    });
    expect(parseDeepLink('openchamber://sessions?filter=attention')).toEqual({
      type: 'sessions',
      filter: 'attention',
    });
  });

  test('parses status, settings, changes, and view overlays', () => {
    expect(parseDeepLink('openchamber://status')).toEqual({ type: 'status' });
    expect(parseDeepLink('openchamber://settings/instances')).toEqual({ type: 'settings', section: 'instances' });
    expect(parseDeepLink('openchamber://changes/src/a.ts?staged=true')).toEqual({
      type: 'changes',
      path: 'src/a.ts',
      staged: true,
    });
    expect(parseDeepLink('openchamber://view/files')).toEqual({ type: 'view', target: 'files' });
    expect(parseDeepLink('openchamber://view/mcp')).toEqual({ type: 'view', target: 'mcp' });
    expect(parseDeepLink('openchamber://view/instances')).toEqual({ type: 'view', target: 'instances' });
    expect(parseDeepLink('openchamber://view/update')).toEqual({ type: 'view', target: 'update' });
    expect(parseDeepLink('openchamber://view/changes')).toEqual({ type: 'changes' });
  });

  test('accepts legacy dir= and path= aliases', () => {
    expect(parseDeepLink('openchamber://new-session?dir=/legacy')).toMatchObject({ directory: '/legacy' });
    expect(parseDeepLink('openchamber://new-session?path=/codex')).toMatchObject({ directory: '/codex' });
  });
});

describe('buildDeepLink', () => {
  test('rebuilds canonical connect and navigation links', () => {
    expect(buildDeepLink({ type: 'connect', pairing })).toBe(encodePairingConnectionPayload(pairing));
    expect(buildDeepLink({ type: 'new-session', directory: '/tmp/demo', prompt: 'ship it' })).toBe(
      'openchamber://new-session?directory=%2Ftmp%2Fdemo&prompt=ship+it',
    );
    expect(buildDeepLink({ type: 'open-project', directory: '/tmp/demo' })).toBe(
      'openchamber://open-project?directory=%2Ftmp%2Fdemo',
    );
    expect(buildDeepLink({ type: 'session', sessionId: 'ses_1', directory: '/repo' })).toBe(
      'openchamber://session/ses_1?directory=%2Frepo',
    );
  });
});
