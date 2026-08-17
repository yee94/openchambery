import { OpenCode } from '@opencode-ai/client';

/**
 * @typedef {import('@opencode-ai/client').OpenCodeClient} OpenCodeV2Client
 */

/**
 * Create the single server-side client for official OpenCode v2 APIs.
 *
 * @param {{ baseUrl: string, authHeaders?: Record<string, string>, fetchImpl?: typeof fetch }} input
 * @returns {OpenCodeV2Client}
 */
export function makeOpenCodeV2Client({ baseUrl, authHeaders, fetchImpl }) {
  return OpenCode.make({
    baseUrl: baseUrl.replace(/\/$/, ''),
    ...(authHeaders ? { headers: authHeaders } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
