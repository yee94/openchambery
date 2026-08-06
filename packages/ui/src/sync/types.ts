import type {
  Agent,
  Command,
  Config,
  LspStatus,
  McpStatus,
  Message,
  Part,
  Path,
  PermissionRequest,
  Project,
  ProviderAuthResponse,
  ProviderListResponse,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
  VcsInfo,
} from "@opencode-ai/sdk/v2/client"

export type FileDiff = {
  file?: string
  status?: string
  additions?: number
  deletions?: number
  patch?: string
  [key: string]: unknown
}

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

/** Per-directory store state */
export type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  command: Command[]
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider: ProviderListResponse
  config: Config
  path: Path
  session: Session[]
  sessionTotal: number
  session_status: Record<string, SessionStatus>
  session_status_observed_at: Record<string, number>
  session_status_snapshot_at: number | undefined
  session_diff: Record<string, FileDiff[]>
  todo: Record<string, Todo[]>
  permission: Record<string, PermissionRequest[]>
  question: Record<string, QuestionRequest[]>
  mcp: Record<string, McpStatus>
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  limit: number
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  /**
   * Per-session older-history boundary. Keyed by session ID; a missing entry
   * reads as `unknown`. Live append never mutates it; eviction deletes the
   * entry with the rest of the session cache.
   */
  session_history_boundary: Record<string, SessionHistoryBoundary>
}

/** Global store state */
export type GlobalState = {
  ready: boolean
  error?: InitError
  path: Path
  projects: Project[]
  providers: ProviderListResponse
  providerAuth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
  sessionTodo: Record<string, Todo[]>
}

type InitError = {
  type: "init"
  message: string
}

/**
 * Client history boundary for a session transcript, scoped to one directory
 * child store. This is the only client-side read source for older-history
 * availability (`hasMore` / `isComplete` / `loadMore` cursor):
 *
 * - `unknown`   — no successful authoritative page has established the
 *   boundary yet (fresh store, post-eviction, or a failed first load). An
 *   unknown boundary must trigger an authoritative tail refresh; cached
 *   messages alone never prove history availability.
 * - `has-more`  — an authoritative page returned `complete=false` with a
 *   non-empty cursor. `cursor` is required and must be non-empty.
 * - `exhausted` — an authoritative page returned `complete=true`; no cursor
 *   exists by contract.
 *
 * `loadedTurns` is the cumulative authored-user turn budget loaded so far
 * (product limit, never a message count). Request lifecycle
 * (idle/loading/error) is tracked separately in `session-prefetch-cache.ts`
 * and never participates in the boundary.
 */
export type SessionHistoryBoundary =
  | { kind: "unknown"; loadedTurns: number }
  | { kind: "has-more"; cursor: string; loadedTurns: number }
  | { kind: "exhausted"; loadedTurns: number }

export const UNKNOWN_SESSION_HISTORY_BOUNDARY: SessionHistoryBoundary = {
  kind: "unknown",
  loadedTurns: 0,
}

export type DirState = {
  lastAccessAt: number
}

export type EvictPlan = {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  max: number
  ttl: number
  now: number
  hasPendingBlockingRequests?: (directory: string) => boolean
}

export type DisposeCheck = {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
  hasPendingBlockingRequests: boolean
}

export const MAX_DIR_STORES = 30
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_CACHE_LIMIT = 40

export const INITIAL_STATE: State = {
  project: "",
  projectMeta: undefined,
  icon: undefined,
  provider: { all: [], connected: [], default: {} },
  config: {},
  path: { state: "", config: "", worktree: "", directory: "", home: "" },
  status: "loading",
  agent: [],
  command: [],
  session: [],
  sessionTotal: 0,
  session_status: {},
  session_status_observed_at: {},
  session_status_snapshot_at: undefined,
  session_diff: {},
  todo: {},
  permission: {},
  question: {},
  mcp: {},
  lsp: [],
  vcs: undefined,
  // Matches DIRECTORY_SESSION_LIMIT / session-index SESSION_LIMIT (one cold-start page).
  limit: 20,
  message: {},
  part: {},
  session_history_boundary: {},
}

export const INITIAL_GLOBAL_STATE: GlobalState = {
  ready: false,
  path: { state: "", config: "", worktree: "", directory: "", home: "" },
  projects: [],
  providers: { all: [], connected: [], default: {} },
  providerAuth: {},
  config: {},
  reload: undefined,
  sessionTodo: {},
}
