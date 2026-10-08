import { queryOptions } from "@tanstack/react-query"
import { queryClient } from "@/lib/queryRuntime"
import { fetchSessionInboxAuthority } from "./session-prompt-api"
import {
  captureInboxRuntimeScope,
  isCurrentInboxRuntimeScope,
  replaceInboxOverlayFromAuthority,
  useSessionInboxOverlayStore,
} from "./session-inbox-overlay"

export function sessionInboxQueryOptions(input: { sessionID: string; directory: string }) {
  const runtime = captureInboxRuntimeScope()
  const directory = input.directory.trim()
  return queryOptions({
    queryKey: [runtime.transportIdentity, runtime.generation, "session-inbox", directory, input.sessionID] as const,
    queryFn: async ({ signal }) => {
      if (!isCurrentInboxRuntimeScope(runtime)) throw new Error("Runtime changed")
      const observedItems = useSessionInboxOverlayStore.getState().list(input.sessionID)
      const snapshot = await fetchSessionInboxAuthority({
        sessionID: input.sessionID,
        directory,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      })
      if (signal.aborted || !snapshot.current || !isCurrentInboxRuntimeScope(runtime)) throw new Error("Runtime changed")
      replaceInboxOverlayFromAuthority(input.sessionID, snapshot.items, { startedMark: snapshot.startedMark, observedItems })
      return snapshot
    },
    staleTime: 0,
    gcTime: 60_000,
    retry: 1,
    retryDelay: 250,
  })
}

export function refreshSessionInbox(input: { sessionID: string; directory: string }) {
  return queryClient.fetchQuery(sessionInboxQueryOptions(input))
}
