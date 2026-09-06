import { describe, expect, test } from 'vitest';

import { buildPairingConnectionPayload, encodePairingConnectionPayload } from './pairing.ts';
import { buildDeepLink, parseDeepLink } from './deepLinks.ts';
import { createLynxDeepLinkInbox } from './applyDeepLink.ts';

const pairing = buildPairingConnectionPayload({
  pairingId: 'pair_deep_link',
  secret: 'one-time-secret',
  candidates: [{ type: 'lan', url: 'http://192.168.1.20:4096' }],
});

describe('parseDeepLink', () => {
  test('parses the same intent union as Cap', () => {
    expect(parseDeepLink(encodePairingConnectionPayload(pairing))).toEqual({ type: 'connect', pairing });
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
    expect(parseDeepLink('openchamber://new?dir=/legacy')?.type).toBe('new-session');
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
    expect(parseDeepLink('openchamber://status')).toEqual({ type: 'status' });
    expect(parseDeepLink('openchamber://settings/appearance')).toEqual({
      type: 'settings',
      section: 'appearance',
    });
    expect(parseDeepLink('openchamber://changes/src/app.ts?staged=true')).toEqual({
      type: 'changes',
      path: 'src/app.ts',
      staged: true,
    });
    expect(parseDeepLink('openchamber://view/instances')).toEqual({ type: 'view', target: 'instances' });
    expect(parseDeepLink('openchamber://view/files')).toEqual({ type: 'view', target: 'files' });
    expect(parseDeepLink('openchamber://view/mcp')).toEqual({ type: 'view', target: 'mcp' });
    expect(parseDeepLink('openchamber://view/update')).toEqual({ type: 'view', target: 'update' });
  });

  test('rejects malformed and legacy connect links', () => {
    expect(parseDeepLink('openchamber://connect?v=2&p=not-json')).toBeNull();
    expect(parseDeepLink('openchamber://connect?v=1&server=https%3A%2F%2Fexample.com&token=secret')).toBeNull();
    expect(parseDeepLink('openchamber://open-project')).toBeNull();
    expect(parseDeepLink('https://example.com')).toBeNull();
  });

  test('rebuilds canonical URLs', () => {
    expect(buildDeepLink({ type: 'connect', pairing })).toBe(encodePairingConnectionPayload(pairing));
    expect(buildDeepLink({ type: 'new-session', directory: '/tmp/demo', prompt: 'ship it' })).toBe(
      'openchamber://new-session?directory=%2Ftmp%2Fdemo&prompt=ship+it',
    );
    expect(buildDeepLink({ type: 'view', target: 'mcp' })).toBe('openchamber://view/mcp');
  });
});

describe('deep link inbox', () => {
  test('redeems pairing before the shell is ready and stashes navigation', () => {
    const inbox = createLynxDeepLinkInbox();
    const redeemed: string[] = [];
    inbox.setPairingHandler((next) => {
      redeemed.push(next.pairingId);
    });

    const pairingResult = inbox.applyUrl(encodePairingConnectionPayload(pairing));
    expect(pairingResult.kind).toBe('pairing-started');
    expect(redeemed).toEqual(['pair_deep_link']);

    const nav = inbox.applyUrl('openchamber://session/ses_wait');
    expect(nav.kind).toBe('stashed');
    expect(inbox.peekPending()?.type).toBe('session');

    let opened = '';
    inbox.setHandlers({
      openSession: (sessionId) => {
        opened = sessionId;
      },
    });
    inbox.setReady(true);
    expect(opened).toBe('ses_wait');
  });
});
