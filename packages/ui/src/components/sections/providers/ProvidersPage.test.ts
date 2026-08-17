import { describe, expect, mock, test } from 'bun:test';
import { filterMethodsWithIndex, shouldLoadAvailableProviders } from './providerAvailability';

mock.module('@/lib/opencode/client', () => ({ opencodeClient: { getSdkClient: () => ({}) } }));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async () => new Response('{}') }));
mock.module('@/stores/useConfigStore', () => ({ useConfigStore: () => null }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: () => null }));
mock.module('@/stores/useAgentsStore', () => ({ reloadOpenCodeConfiguration: async () => undefined }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }), getCurrentIntlLocale: () => 'en' }));
mock.module('@/lib/clipboard', () => ({ copyTextToClipboard: async () => ({ ok: true }) }));
mock.module('@/lib/url', () => ({ openExternalUrl: () => undefined }));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined, success: () => undefined, message: () => undefined } }));
mock.module('@/hooks/useProviderLogo', () => ({ useProviderLogo: () => ({ src: null, onError: () => undefined, hasLogo: false }) }));
mock.module('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: () => null }));
mock.module('@/components/ui/button', () => ({ Button: () => null }));
mock.module('@/components/ui/input', () => ({ Input: () => null }));
mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: () => null,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
  DropdownMenuTrigger: () => null,
}));
mock.module('@/components/ui/tooltip', () => ({ Tooltip: () => null, TooltipContent: () => null, TooltipTrigger: () => null }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/sections/shared/SettingsGroup', () => ({ SettingsGroup: () => null }));
mock.module('./QuotaCredentials', () => ({ QuotaCredentials: () => null }));

const { buildAuthMethodsFromIntegrations, resolveIntegrationId } = await import('./ProvidersPage');

describe('ProvidersPage available provider loading', () => {
  test('loads available providers only in add-provider mode', () => {
    expect(shouldLoadAvailableProviders(false)).toBe(false);
    expect(shouldLoadAvailableProviders(true)).toBe(true);
  });

  test('keeps the original auth method index when selecting OAuth methods', () => {
    const methods = [
      { type: 'api', label: 'API key' },
      { type: 'oauth', label: 'ChatGPT browser' },
      { type: 'oauth', label: 'ChatGPT headless' },
    ];

    expect(filterMethodsWithIndex(methods, (method) => method.type === 'oauth')).toEqual([
      { method: methods[1], methodIndex: 1 },
      { method: methods[2], methodIndex: 2 },
    ]);
  });
});

describe('ProvidersPage integration mapping', () => {
  test('prefers provider.integrationID and keeps oauth method ids', () => {
    expect(resolveIntegrationId('openai', [{ id: 'openai', integrationID: 'openai-int' }], [{ id: 'openai-int' }])).toBe('openai-int');

    const mapped = buildAuthMethodsFromIntegrations(
      [{ id: 'openai', integrationID: 'openai-int', name: 'OpenAI' }],
      [{
        id: 'openai-int',
        name: 'OpenAI',
        methods: [
          { id: 'browser', type: 'oauth', label: 'ChatGPT browser' },
          { type: 'key', label: 'API key' },
        ],
      }],
    );

    expect(mapped.integrationIdByProvider.openai).toBe('openai-int');
    expect(mapped.methodsByProvider.openai).toEqual([
      { type: 'oauth', id: 'browser', name: 'ChatGPT browser', label: 'ChatGPT browser' },
      { type: 'key', id: undefined, name: 'API key', label: 'API key' },
    ]);
  });
});
