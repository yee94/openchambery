import { runtimeFetch } from '@/lib/runtime-fetch';

type OpenCodeHealth = {
  openCodeRunning?: unknown;
  isOpenCodeReady?: unknown;
};

export async function checkOpenCodeAvailability(): Promise<boolean> {
  const response = await runtimeFetch('/health');
  if (!response.ok) return false;

  const data = (await response.json().catch(() => null)) as OpenCodeHealth | null;
  return data?.openCodeRunning === true || data?.isOpenCodeReady === true;
}

export async function retryOpenCodeAvailability(): Promise<boolean> {
  const response = await runtimeFetch('/api/opencode/retry', { method: 'POST' });
  if (!response.ok) return false;
  // Retry endpoint waits for managed startup, but treat readiness as
  // authoritative health — never enter the main shell on a bare HTTP 200.
  return checkOpenCodeAvailability();
}
