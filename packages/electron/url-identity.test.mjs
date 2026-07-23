import { describe, expect, test } from 'bun:test';
import {
  isPackagedUiUrl,
  packagedUiOrigin,
  sameUrlIdentity,
  urlIdentityKey,
} from './url-identity.mjs';

describe('urlIdentityKey / packaged UI navigation', () => {
  test('openchamber-ui URL.origin is the string null but identity is stable', () => {
    const href = 'openchamber-ui://app/index.html';
    expect(new URL(href).origin).toBe('null');
    expect(urlIdentityKey(href)).toBe('openchamber-ui://app');
    expect(urlIdentityKey(href)).toBe(packagedUiOrigin());
  });

  test('isPackagedUiUrl accepts reloads of the packaged app', () => {
    expect(isPackagedUiUrl('openchamber-ui://app/index.html')).toBe(true);
    expect(isPackagedUiUrl('openchamber-ui://app/')).toBe(true);
    expect(isPackagedUiUrl('https://example.com')).toBe(false);
    expect(isPackagedUiUrl('openchamber-ui://other/path')).toBe(false);
  });

  test('sameUrlIdentity matches reload target to packaged origin without using URL.origin', () => {
    expect(sameUrlIdentity('openchamber-ui://app/index.html', packagedUiOrigin())).toBe(true);
    expect(sameUrlIdentity('openchamber-ui://app/index.html', 'openchamber-ui://app')).toBe(true);
    // The historical broken comparison:
    expect(new URL('openchamber-ui://app/index.html').origin === packagedUiOrigin()).toBe(false);
  });

  test('http(s) origins still compare normally', () => {
    expect(urlIdentityKey('http://127.0.0.1:57123/health')).toBe('http://127.0.0.1:57123');
    expect(sameUrlIdentity('http://127.0.0.1:57123/a', 'http://127.0.0.1:57123/b')).toBe(true);
    expect(sameUrlIdentity('http://127.0.0.1:57123', 'http://127.0.0.1:3901')).toBe(false);
  });
});
