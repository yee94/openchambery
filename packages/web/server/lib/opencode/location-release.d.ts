import type { OpenCodeClient } from '@opencode/client';

export type LocationReleaseResult = { state: 'released' | 'timeout' | 'failed' | 'unavailable' };
export function releaseDeletedWorktreeLocation(input: {
  getClient: () => OpenCodeClient | null;
  directory: string;
  timeoutMs?: number;
}): Promise<LocationReleaseResult>;
