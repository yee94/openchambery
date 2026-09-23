/**
 * Demand-driven directory location services (Ticket 09).
 *
 * Demand is the set of mounted, enabled TanStack Query observers for a
 * location-scoped catalog (MCP configs/status, command catalog). Directory
 * bootstrap never reads these catalogs. When a location shuts down or the
 * connection recovers, only observed catalogs refetch; unobserved ones are
 * marked stale and load on their next consumer. Runtime isolation comes from
 * the transport identity in every query key plus the client clear on runtime
 * identity change.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query"

function normalizeLocationDirectory(directory: unknown): string | null {
  if (typeof directory !== "string") return null
  const trimmed = directory.trim().replace(/\\/g, "/")
  if (!trimmed) return null
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed
}

/** `undefined` = not a location service; `null` = default-directory query. */
function locationServiceDirectory(queryKey: QueryKey): string | null | undefined {
  // [transport, "commands", directory]
  if (queryKey[1] === "commands") return normalizeLocationDirectory(queryKey[2])
  // [transport, "mcp", "configs" | "status", directory]
  if (queryKey[1] === "mcp" && (queryKey[2] === "configs" || queryKey[2] === "status")) {
    return normalizeLocationDirectory(queryKey[3])
  }
  return undefined
}

/**
 * Invalidate location-service catalogs for one directory (or every directory
 * when `directory` is omitted) on the given transport. Only queries with an
 * active observer refetch.
 */
export function refreshDemandedLocationServices(
  client: Pick<QueryClient, "invalidateQueries">,
  input: { transport: string; directory?: string },
): Promise<void> {
  const directory = input.directory === undefined ? undefined : normalizeLocationDirectory(input.directory)
  if (input.directory !== undefined && !directory) return Promise.resolve()
  return client.invalidateQueries({
    predicate: (query) => {
      if (query.queryKey[0] !== input.transport) return false
      const serviceDirectory = locationServiceDirectory(query.queryKey)
      if (serviceDirectory === undefined) return false
      return directory === undefined || serviceDirectory === directory
    },
    refetchType: "active",
  })
}

/** Directory released by an upstream location shutdown event, if any. */
export function locationShutdownDirectory(
  event: { type: string; properties?: unknown },
  routedDirectory: string,
): string | null {
  if (event.type !== "location.shutdown" && event.type !== "server.instance.disposed") return null
  const own = (event.properties as { directory?: unknown } | undefined)?.directory
  const directory = typeof own === "string" && own.trim() ? own : routedDirectory
  return directory && directory !== "global" ? directory : null
}
