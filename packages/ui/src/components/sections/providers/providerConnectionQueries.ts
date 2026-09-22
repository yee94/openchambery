import { queryOptions } from '@tanstack/react-query';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

export const providerConnectionQueryOptions = (directory = opencodeClient.getDirectory()) => queryOptions({
  queryKey: [getRuntimeTransportIdentity(), getRuntimeGeneration(), 'provider-connections', directory ?? null],
  queryFn: async ({ signal }) => {
    const sdk = opencodeClient.getSdkClient();
    const location = directory ? { directory } : undefined;
    const [providers, integrations] = await Promise.all([
      sdk.provider.list({ location }, { signal }),
      sdk.integration.list({ location }, { signal }),
    ]);
    return { providers: providers.data, integrations: integrations.data };
  },
});
