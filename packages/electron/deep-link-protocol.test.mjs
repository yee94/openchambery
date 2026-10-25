import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEEP_LINK_PROTOCOLS, isAppDeepLink } from './deep-link-protocol.mjs';

describe('external deep-link compatibility', () => {
  it.each(['yuri', 'openchamber', 'openchambery'])('admits %s without rewriting route, scope or payload', (scheme) => {
    const link = `${scheme}://connect?v=2&p=opaque%2Bpayload%2Fvalue`;
    const args = ['/path/to/app', '--flag', link];
    expect(args.filter(isAppDeepLink)).toEqual([link]);
    expect(isAppDeepLink(`${scheme.toUpperCase()}://new-session?directory=%2Fworkspace`)).toBe(true);
    expect(isAppDeepLink(`${scheme}://session/session_1?directory=%2Fa%20b`)).toBe(true);
  });

  it('rejects unrelated URLs, nested schemes, internal resources and malformed input', () => {
    for (const value of [null, undefined, '', 'not a URL', 'https://example.com/?next=yuri://settings',
      'yuri-ui://app', 'yuri-asset://stream/id', 'yuri-other://session/id', 'yuri://']) {
      expect(isAppDeepLink(value)).toBe(false);
    }
  });

  it('packages every accepted scheme in the desktop installer', () => {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    expect(pkg.build.protocols.schemes).toEqual(DEEP_LINK_PROTOCOLS);
  });

  it('registers the same external schemes in both mobile shells', () => {
    const plist = readFileSync(new URL('../mobile/ios/App/App/Info.plist', import.meta.url), 'utf8');
    const schemes = plist.match(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
    const ios = [...schemes.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]);
    const manifest = readFileSync(new URL('../mobile/android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
    const android = [...manifest.matchAll(/<data android:scheme="([^"]+)"/g)].map((match) => match[1]);
    expect(ios).toEqual(DEEP_LINK_PROTOCOLS);
    expect(android).toEqual(DEEP_LINK_PROTOCOLS);
  });
});
