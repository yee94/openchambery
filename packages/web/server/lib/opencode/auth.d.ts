import type { OpenCodeClient } from '@opencode/client';

export type ProviderCredential =
  | { type: 'api'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number; accountId?: string; enterpriseUrl?: string };
export function configureOpenCodeCredentials(resolveClient: (() => OpenCodeClient) | null): void;
export function openCodeCredentialSource(deps: {
  buildOpenCodeUrl: (path: string, prefix?: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
}): () => OpenCodeClient;
export function readOpenCodeCredentials(): Promise<Record<string, ProviderCredential>>;
export function getProviderAuth(providerId: string): Promise<ProviderCredential | null>;
export function removeProviderAuth(providerId: string): Promise<boolean>;
