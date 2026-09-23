import { OpenCode } from '@opencode/client';
import { wrapFetchWithRuntimeContractGate } from './server-opencode-fetch.js';

/**
 * @typedef {import('@opencode/client').OpenCodeClient} OpenCodeV2ClientRaw
 */

/**
 * Compatibility client: official 2.x nests exact message lookup under
 * `session.message.get`, while OpenChamber callers still use
 * `session.message(input, requestOptions)`.
 *
 * @typedef {Omit<OpenCodeV2ClientRaw, 'session'> & {
 *   session: Omit<OpenCodeV2ClientRaw['session'], 'message'> & {
 *     message: ((input: Parameters<OpenCodeV2ClientRaw['session']['message']['get']>[0], requestOptions?: Parameters<OpenCodeV2ClientRaw['session']['message']['get']>[1]) => ReturnType<OpenCodeV2ClientRaw['session']['message']['get']>)
 *       & OpenCodeV2ClientRaw['session']['message']
 *   }
 * }} OpenCodeV2Client
 */

/**
 * Create the single server-side client for official OpenCode v2 APIs.
 * Fetch is always wrapped with runtime-contract write admission so Host
 * background clients (queue / scheduled / assistants) cannot bypass the proxy gate.
 *
 * @param {{
 *   baseUrl: string,
 *   authHeaders?: Record<string, string>,
 *   fetchImpl?: typeof fetch,
 *   getRuntimeContract?: () => (object | null | undefined),
 * }} input
 * @returns {OpenCodeV2Client}
 */
export function makeOpenCodeV2Client({ baseUrl, authHeaders, fetchImpl, getRuntimeContract }) {
  const gatedFetch = wrapFetchWithRuntimeContractGate(fetchImpl || fetch, {
    ...(typeof getRuntimeContract === 'function' ? { getRuntimeContract } : {}),
  });
  const client = OpenCode.make({
    baseUrl: baseUrl.replace(/\/$/, ''),
    ...(authHeaders ? { headers: authHeaders } : {}),
    fetch: gatedFetch,
  });

  const messageGet = client.session.message?.get?.bind(client.session.message);
  if (typeof messageGet === 'function') {
    const messageCompat = Object.assign(
      (input, requestOptions) => messageGet(input, requestOptions),
      client.session.message,
    );
    return {
      ...client,
      session: {
        ...client.session,
        message: messageCompat,
      },
    };
  }

  return client;
}
