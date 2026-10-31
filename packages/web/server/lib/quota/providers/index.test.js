import { describe, expect, it } from 'vitest';

import * as google from './google/index.js';
import { fetchQuotaForProvider, listConfiguredQuotaProviders } from './index.js';

describe('quota provider registry', () => {
  it('exposes google provider configuration helpers through the provider module', () => {
    expect(google.providerId).toBe('google');
    expect(google.providerName).toBe('Google');
    expect(typeof google.isConfigured).toBe('function');
    expect(typeof google.resolveGoogleAuthSources).toBe('function');
  });

  it('reports unavailable credentials instead of an empty configured-provider list', async () => {
    await expect(listConfiguredQuotaProviders()).rejects.toThrow('Unable to read OpenCode credentials');
  });

  it('does not report a provider as configured when the credential source is unavailable', async () => {
    const result = await fetchQuotaForProvider('claude');
    expect(result).toMatchObject({ ok: false, configured: false, error: 'Unable to read OpenCode credentials' });
  });
});
