export const getRuntimeTransportIdentity = () => 'direct:benchmark';
export const getRuntimeGeneration = () => 0;
export const subscribeRuntimeEndpointChanged = () => () => {};
export const getRuntimeAuthGeneration = () => 0;
export const getRuntimeBearerTokenSync = () => 'benchmark-only';
export const subscribeRuntimeAuthGeneration = () => () => {};
export const runtimeFetch = (route: string, options: { query?: Record<string, string>; signal?: AbortSignal } = {}) => {
  const url = new URL(route, location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
  return fetch(url, { signal: options.signal });
};
export const getRegisteredRuntimeAPIs = () => ({ files: { statFile: async () => (await fetch('/stat')).json() } });
export const fileStatQueryOptions = (files: { statFile: () => Promise<unknown> }) => ({ queryFn: files.statFile });
export const queryClient = { fetchQuery: ({ queryFn }: { queryFn: () => Promise<unknown> }) => queryFn() };
