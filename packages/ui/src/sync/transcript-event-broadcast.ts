/**
 * Pure helper: choose every current-runtime canonical scope that should
 * receive one transcript SSE command.
 *
 * Canonical / durable transcripts are isolated by
 * [transport, generation, directory, sessionID]. A live event must merge
 * into every matching directory that already holds that session, not only
 * the single resolvedDirectory used for child-store routing.
 */

import type { TranscriptScope } from "./transcript-repository"

export type TranscriptEventBroadcastInput = {
  readonly sessionID: string
  readonly resolvedDirectory: string
  readonly transport: string
  readonly generation: number
  readonly listCanonicalScopes: (sessionID: string) => readonly TranscriptScope[]
}

/**
 * List scopes that should apply one transcript SSE event.
 * All sessionID matches on the current transport/generation win;
 * zero hits fall back to the resolved directory.
 */
export function listTranscriptEventBroadcastScopes(
  input: TranscriptEventBroadcastInput,
): TranscriptScope[] {
  const matches = input.listCanonicalScopes(input.sessionID).filter((scope) => (
    scope.sessionID === input.sessionID
    && scope.transport === input.transport
    && scope.generation === input.generation
  ))
  if (matches.length > 0) {
    return [...matches]
  }
  return [{
    directory: input.resolvedDirectory,
    sessionID: input.sessionID,
    transport: input.transport,
    generation: input.generation,
  }]
}
