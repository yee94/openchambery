export function magpieBaseURL(value: string): string;
export function fetchMagpieQuotas(options?: {
  directory?: string;
  manualURL?: string;
  refresh?: boolean;
  signal?: AbortSignal;
}): Promise<{ sources: Array<{ id: string; name: string; results: unknown[]; error?: string; identified?: boolean; ignored?: boolean }>; incomplete: boolean }>;
