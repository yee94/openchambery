import type {
  Agent,
  Command,
  Config,
  LspStatus,
  McpStatus,
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
  /** Live `session.error` observation time. Not persisted history; busy/retry clears. */
  session_error_at: Record<string, number>
  session_diff: Record<string, FileDiff[]>
  todo: Record<string, Todo[]>
  permission: Record<string, PermissionRequest[]>
  question: Record<string, QuestionRequest[]>
  mcp: Record<string, McpStatus>
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  limit: number
  // Ticket 09 batch 2: message / part / session_history_boundary live only in
  // QueryCache (production) or pure TranscriptStoreSurface drafts (tests).
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
 * Client history boundary for a session transcript. Production authority is
 * QueryCache / TranscriptRepository pagination (not DirectoryStore State).
 *
 * - `unknown`   — no successful authoritative page has established the boundary
 * - `has-more`  — complete=false with a non-empty cursor
 * - `exhausted` — complete=true; no cursor
 *
 * `loadedTurns` is the cumulative authored-user turn budget loaded so far.
 * Request lifecycle is repository getRequestState (not session-prefetch-cache).
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
  /**
   * Soft overflow grace. Directories touched more recently than this are not
   * overflow victims (they are almost certainly still mounting / waiting for
   * pin effects). Idle TTL eviction is unaffected.
   */
  graceMs?: number
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

/** Soft cap: burst mounts may briefly exceed this while grace windows hold. */
export const MAX_DIR_STORES = 30
/**
 * Directories touched within this window are never overflow-evicted. Prevents
 * the expand-many-worktrees thrash where ensureChild (render) runs before pin
 * effects (commit) and immediately disposes still-mounted directories.
 */
export const EVICTION_GRACE_MS = 30 * 1000
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
  session_error_at: {},
  session_diff: {},
  todo: {},
  permission: {},
  question: {},
  mcp: {},
  lsp: [],
  vcs: undefined,
  // Matches DIRECTORY_SESSION_LIMIT / session-index SESSION_LIMIT (one cold-start page).
  limit: 20,
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
