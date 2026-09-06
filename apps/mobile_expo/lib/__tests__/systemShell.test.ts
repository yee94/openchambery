import { describe, expect, it } from 'vitest';

import { buildDeepLink, parseDeepLink, sessionIdFromPushData } from '../systemShell/deepLinks';
import { assertHttpUrl, ExternalBrowserError } from '../systemShell/externalBrowser';
import {
  isLiveActivityStatus,
  liveActivitySessionUrl,
  validateLiveActivityRequest,
} from '../systemShell/liveActivity';
import {
  parseShareCatalogEntry,
  parseShareEnvelope,
  resolveShareTarget,
} from '../systemShell/share';

describe('deepLinks', () => {
  it('parses openchamber://session/{id}', () => {
    expect(parseDeepLink('openchamber://session/abc-123')).toEqual({
      type: 'session',
      sessionId: 'abc-123',
      directory: undefined,
    });
  });

  it('builds session deep links', () => {
    expect(buildDeepLink({ type: 'session', sessionId: 's1' })).toBe(
      'openchamber://session/s1',
    );
  });

  it('extracts session id from push data', () => {
    expect(sessionIdFromPushData({ sessionId: 'x' })).toBe('x');
    expect(sessionIdFromPushData({ url: 'openchamber://session/y' })).toBe('y');
    expect(sessionIdFromPushData({})).toBeNull();
  });

  it('rejects foreign schemes', () => {
    expect(parseDeepLink('https://example.com/session/x')).toBeNull();
  });
});

describe('externalBrowser', () => {
  it('allows http(s) only', () => {
    expect(assertHttpUrl('https://oauth.example/authorize')).toContain('https://');
    expect(() => assertHttpUrl('javascript:alert(1)')).toThrow(ExternalBrowserError);
    expect(() => assertHttpUrl('file:///etc/passwd')).toThrow(ExternalBrowserError);
    expect(() => assertHttpUrl('')).toThrow(ExternalBrowserError);
  });
});

describe('liveActivity', () => {
  it('validates Cap status vocabulary', () => {
    expect(isLiveActivityStatus('working')).toBe(true);
    expect(isLiveActivityStatus('retry')).toBe(true);
    expect(isLiveActivityStatus('nope')).toBe(false);
  });

  it('requires fields for start', () => {
    expect(
      validateLiveActivityRequest(
        {
          sessionId: 's',
          status: 'working',
          eventVersion: 1,
          updatedAt: Date.now(),
        },
        true,
      ),
    ).toBe('startedAt is required');
  });

  it('builds session URLs for rows', () => {
    expect(liveActivitySessionUrl('sess')).toBe('openchamber://session/sess');
  });
});

describe('share', () => {
  it('parses catalog entries and resolves exact instance+assistant', () => {
    const a = parseShareCatalogEntry({
      serverInstanceID: 'srv',
      assistantID: 'asst',
      name: 'Bot',
      avatarSeed: 'asst',
      serverLabel: 'Home',
      connectionKey: 'k',
      enabled: true,
      isDefaultShareTarget: false,
    });
    const b = parseShareCatalogEntry({
      serverInstanceID: 'srv2',
      assistantID: 'asst2',
      name: 'Default',
      avatarSeed: 'asst2',
      serverLabel: 'Away',
      connectionKey: 'k2',
      enabled: true,
      isDefaultShareTarget: true,
    });
    expect(a).not.toBeNull();
    expect(resolveShareTarget([a!, b!], 'srv', 'asst')?.assistantID).toBe('asst');
    expect(resolveShareTarget([a!, b!])?.assistantID).toBe('asst2');
  });

  it('parses share envelopes without tokens', () => {
    const env = parseShareEnvelope({
      version: 1,
      operationID: 'op1',
      serverInstanceID: 'srv',
      assistantID: 'asst',
      text: 'hi',
      attachments: [],
      source: 'ios-share',
      createdAt: 1,
      expiresAt: 2,
    });
    expect(env?.operationID).toBe('op1');
    expect(parseShareEnvelope({ version: 2 })).toBeNull();
  });
});
