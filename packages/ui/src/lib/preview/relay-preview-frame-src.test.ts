import { describe, expect, it } from 'vitest';
import { isNormalizedPreviewProxyPath, resolveRelayPreviewFrameSrc } from './relay-preview-frame-src';

describe('resolveRelayPreviewFrameSrc', () => {
  const authenticated = '/api/preview/proxy/abc123/index.html?oc_preview_token=p&oc_url_token=u#top';
  const absoluteAuthenticated = 'https://host.example/api/preview/proxy/abc123/?oc_preview_token=p&oc_url_token=u';

  it('returns authenticated asset unchanged when relay is inactive', () => {
    expect(resolveRelayPreviewFrameSrc({
      relayActive: false,
      gatewayOrigin: 'http://127.0.0.1:9999',
      authenticatedAssetUrl: authenticated,
    })).toBe(authenticated);

    expect(resolveRelayPreviewFrameSrc({
      relayActive: false,
      gatewayOrigin: null,
      authenticatedAssetUrl: absoluteAuthenticated,
    })).toBe(absoluteAuthenticated);
  });

  it('returns authenticated asset unchanged when gateway origin is missing', () => {
    expect(resolveRelayPreviewFrameSrc({
      relayActive: true,
      gatewayOrigin: '',
      authenticatedAssetUrl: authenticated,
    })).toBe(authenticated);

    expect(resolveRelayPreviewFrameSrc({
      relayActive: true,
      gatewayOrigin: null,
      authenticatedAssetUrl: authenticated,
    })).toBe(authenticated);
  });

  it('rewrites relative proxy path onto loopback gateway origin under relay', () => {
    expect(resolveRelayPreviewFrameSrc({
      relayActive: true,
      gatewayOrigin: 'http://127.0.0.1:54321',
      authenticatedAssetUrl: authenticated,
    })).toBe('http://127.0.0.1:54321/api/preview/proxy/abc123/index.html?oc_preview_token=p&oc_url_token=u#top');
  });

  it('rewrites absolute authenticated asset onto gateway origin under relay', () => {
    expect(resolveRelayPreviewFrameSrc({
      relayActive: true,
      gatewayOrigin: 'http://127.0.0.1:54321',
      authenticatedAssetUrl: absoluteAuthenticated,
    })).toBe('http://127.0.0.1:54321/api/preview/proxy/abc123/?oc_preview_token=p&oc_url_token=u');
  });

  it('rejects non-loopback gateway origins', () => {
    expect(resolveRelayPreviewFrameSrc({
      relayActive: true,
      gatewayOrigin: 'http://192.168.1.2:54321',
      authenticatedAssetUrl: authenticated,
    })).toBe(authenticated);
  });

  it('leaves non-preview paths unchanged even under relay', () => {
    const other = '/api/session?x=1';
    expect(resolveRelayPreviewFrameSrc({
      relayActive: true,
      gatewayOrigin: 'http://127.0.0.1:54321',
      authenticatedAssetUrl: other,
    })).toBe(other);
  });
});

describe('isNormalizedPreviewProxyPath', () => {
  it('accepts preview proxy paths and rejects traversal', () => {
    expect(isNormalizedPreviewProxyPath('/api/preview/proxy/abc123/')).toBe(true);
    expect(isNormalizedPreviewProxyPath('/api/preview/proxy/abc123/?oc_preview_token=x')).toBe(true);
    expect(isNormalizedPreviewProxyPath('/api/preview/proxy/../session')).toBe(false);
    expect(isNormalizedPreviewProxyPath('/api/preview/proxy/%2e%2e/session')).toBe(false);
    expect(isNormalizedPreviewProxyPath('/api/preview/proxy/../../api/session')).toBe(false);
    expect(isNormalizedPreviewProxyPath('/api/session')).toBe(false);
    expect(isNormalizedPreviewProxyPath('http://evil.example/api/preview/proxy/abc')).toBe(false);
  });
});
