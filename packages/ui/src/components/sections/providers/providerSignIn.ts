/** OpenCode Console integration. Go bills through Console; its own integration only accepts a service-account key. */
const OPENCODE_CONSOLE_INTEGRATION_ID = 'opencode';

type SignInConnection = {
  type?: string;
  method?: string;
};

type SignInIntegration = {
  id?: string;
  methods?: Array<{ id?: string; type?: string; label?: string; name?: string }>;
  connections?: SignInConnection[];
};

/**
 * Integration that owns interactive sign-in.
 * OpenCode Go maps to Console (`opencode`); every other provider signs in as itself.
 */
export function getSignInIntegrationId(providerId: string): string {
  return providerId === 'opencode-go' ? OPENCODE_CONSOLE_INTEGRATION_ID : providerId;
}

export function findSignInIntegration(
  providerId: string,
  integrations: readonly SignInIntegration[] | undefined,
): SignInIntegration | undefined {
  const id = getSignInIntegrationId(providerId);
  return integrations?.find((entry) => entry.id === id);
}

/** Console account grant. A stored API key on the same integration is not a Console login. */
export function consoleAccountConnected(integration: SignInIntegration | undefined): boolean {
  return (integration?.connections ?? []).some(
    (connection) => connection.type === 'credential' && connection.method === 'oauth',
  );
}

export function signInOAuthMethods(
  integration: SignInIntegration | undefined,
): Array<{ id: string; label?: string }> {
  return (integration?.methods ?? []).flatMap((method) => (
    method.type === 'oauth' && typeof method.id === 'string' && method.id
      ? [{ id: method.id, label: method.label ?? method.name }]
      : []
  ));
}

export function methodsForSignIn<T>(
  providerId: string,
  methodsByProvider: Record<string, T[]>,
): T[] {
  const signInId = getSignInIntegrationId(providerId);
  return methodsByProvider[signInId] ?? methodsByProvider[providerId] ?? [];
}

/** OAuth target. Key connects stay on the provider's own integration. */
export function signInIntegrationIdForOAuth(
  providerId: string,
  integrationIdByProvider: Record<string, string>,
): string {
  const signInId = getSignInIntegrationId(providerId);
  if (signInId === providerId) return integrationIdByProvider[providerId] || providerId;
  return integrationIdByProvider[signInId] || signInId;
}
