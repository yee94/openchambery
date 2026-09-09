/**
 * Cap MobileApp MCP sheet runtime — live status + connect/disconnect.
 *
 * Cap sources: `McpDropdownContent` + `useMcpStore` + OpenCode SDK:
 *   GET  /mcp
 *   POST /mcp/{name}/connect
 *   POST /mcp/{name}/disconnect
 * Config list stays Cap `/api/config/mcp` (already used by Settings + sheet catalog).
 *
 * OAuth system browser for needs_auth remains host-only — we surface the status
 * honestly and still call real connect (never invent OAuth success).
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { loadMcpCatalog, type LynxCatalogItem } from '../settings/catalogs';

export type LynxMcpRuntimeStatusKind =
  | 'connected'
  | 'disabled'
  | 'failed'
  | 'needs_auth'
  | 'needs_client_registration'
  | 'unknown';

export type LynxMcpRuntimeStatus = {
  kind: LynxMcpRuntimeStatusKind;
  error?: string;
};

export type LynxMcpSheetRow = {
  name: string;
  title: string;
  subtitle?: string;
  status: LynxMcpRuntimeStatus;
  /** Cap Switch `checked` — only true when runtime reports connected. */
  connected: boolean;
};

export type LynxMcpSheetLoadResult =
  | { status: 'ok'; rows: LynxMcpSheetRow[] }
  | { status: 'no-runtime' }
  | { status: 'unsupported' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxMcpActionResult =
  | { status: 'ok'; runtime: LynxMcpRuntimeStatus }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: string; httpStatus: number };

export type LynxMcpStatusTone = 'success' | 'error' | 'warning' | 'default';

const directoryQuery = (directory?: string | null): string => {
  const value = directory?.trim();
  return value ? `?directory=${encodeURIComponent(value)}` : '';
};

const directoryHeaders = (directory?: string | null): Record<string, string> => (
  directory?.trim()
    ? { 'x-opencode-directory': directory.trim() }
    : {}
);

/** Cap `statusTone` from McpDropdown. */
export function lynxMcpStatusTone(status: LynxMcpRuntimeStatus | undefined): LynxMcpStatusTone {
  switch (status?.kind) {
    case 'connected':
      return 'success';
    case 'failed':
      return 'error';
    case 'needs_auth':
    case 'needs_client_registration':
      return 'warning';
    default:
      return 'default';
  }
}

export function parseLynxMcpRuntimeStatus(raw: unknown): LynxMcpRuntimeStatus {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'unknown' };
  }
  const record = raw as { status?: unknown; error?: unknown };
  const kind = typeof record.status === 'string' ? record.status.trim() : '';
  const error = typeof record.error === 'string' && record.error.trim()
    ? record.error.trim()
    : undefined;
  switch (kind) {
    case 'connected':
      return { kind: 'connected' };
    case 'disabled':
      return { kind: 'disabled' };
    case 'failed':
      return { kind: 'failed', error };
    case 'needs_auth':
      return { kind: 'needs_auth' };
    case 'needs_client_registration':
      return { kind: 'needs_client_registration', error };
    default:
      return { kind: 'unknown', error };
  }
}

export function parseLynxMcpStatusMap(payload: unknown): Record<string, LynxMcpRuntimeStatus> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const out: Record<string, LynxMcpRuntimeStatus> = {};
  for (const [name, value] of Object.entries(payload as Record<string, unknown>)) {
    const key = name.trim();
    if (!key) continue;
    out[key] = parseLynxMcpRuntimeStatus(value);
  }
  return out;
}

/** Cap merges status keys ∪ config names, then sorts localeCompare. */
export function mergeLynxMcpSheetRows(
  configs: readonly LynxCatalogItem[],
  statusMap: Record<string, LynxMcpRuntimeStatus>,
): LynxMcpSheetRow[] {
  const names = new Set<string>();
  const configByName = new Map<string, LynxCatalogItem>();
  for (const item of configs) {
    const name = item.id.trim();
    if (!name) continue;
    names.add(name);
    configByName.set(name, item);
  }
  for (const name of Object.keys(statusMap)) {
    if (name.trim()) names.add(name.trim());
  }
  return Array.from(names)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const config = configByName.get(name);
      const status = statusMap[name] ?? { kind: 'unknown' as const };
      return {
        name,
        title: config?.title ?? name,
        subtitle: config?.subtitle,
        status,
        connected: status.kind === 'connected',
      };
    });
}

/**
 * Cap sheet load: configs (`/api/config/mcp`) + status (`GET /mcp`).
 * Config unsupported/empty + status ok still surfaces status-only rows.
 * Status failure with usable configs → rows with unknown status (honest).
 * Both failed → failed. no-runtime when fetch identity missing (status 0).
 */
export async function loadLynxMcpSheet(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { directory?: string | null } = {},
): Promise<LynxMcpSheetLoadResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };

  const catalog = await loadMcpCatalog(runtimeFetch, { directory: input.directory });
  if (catalog.status === 'no-runtime') return { status: 'no-runtime' };

  const query = directoryQuery(input.directory);
  let statusResponse;
  try {
    statusResponse = await runtimeFetch(`/mcp${query}`, {
      method: 'GET',
      headers: directoryHeaders(input.directory),
    });
  } catch (error) {
    if (catalog.status === 'ok') {
      return {
        status: 'ok',
        rows: mergeLynxMcpSheetRows(catalog.items, {}),
      };
    }
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  if (statusResponse.status === 0) {
    return { status: 'no-runtime' };
  }

  let statusMap: Record<string, LynxMcpRuntimeStatus> = {};
  let statusOk = false;
  if (statusResponse.ok) {
    const payload = await statusResponse.json().catch(() => null);
    statusMap = parseLynxMcpStatusMap(payload);
    statusOk = true;
  }

  if (catalog.status === 'ok') {
    return {
      status: 'ok',
      rows: mergeLynxMcpSheetRows(catalog.items, statusMap),
    };
  }

  if (statusOk) {
    // Status-only rows when config list unsupported/failed — Cap still shows status keys.
    return {
      status: 'ok',
      rows: mergeLynxMcpSheetRows([], statusMap),
    };
  }

  if (catalog.status === 'unsupported' && (statusResponse.status === 404 || statusResponse.status === 501)) {
    return { status: 'unsupported' };
  }

  if (catalog.status === 'failed') {
    return {
      status: 'failed',
      error: catalog.error,
      httpStatus: catalog.httpStatus ?? statusResponse.status,
    };
  }

  return {
    status: 'failed',
    error: new Error(`mcp.status failed (${statusResponse.status})`),
    httpStatus: statusResponse.status,
  };
}

async function refreshLynxMcpServerStatus(
  runtimeFetch: LynxRuntimeFetch,
  input: { name: string; directory?: string | null; fallback: LynxMcpRuntimeStatus },
): Promise<LynxMcpRuntimeStatus> {
  const query = directoryQuery(input.directory);
  try {
    const response = await runtimeFetch(`/mcp${query}`, {
      method: 'GET',
      headers: directoryHeaders(input.directory),
    });
    if (!response.ok) return input.fallback;
    const payload = await response.json().catch(() => null);
    const map = parseLynxMcpStatusMap(payload);
    return map[input.name] ?? input.fallback;
  } catch {
    return input.fallback;
  }
}

async function postLynxMcpAction(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { name: string; directory?: string | null; action: 'connect' | 'disconnect' },
): Promise<LynxMcpActionResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const name = input.name.trim();
  if (!name) {
    return { status: 'failed', error: 'MCP server name is required', httpStatus: 400 };
  }
  const query = directoryQuery(input.directory);
  // Cap OpenCode: POST body is boolean; Cap then refreshMcpStatusQuery.
  const fallback: LynxMcpRuntimeStatus = input.action === 'connect'
    ? { kind: 'connected' }
    : { kind: 'disabled' };
  try {
    const response = await runtimeFetch(
      `/mcp/${encodeURIComponent(name)}/${input.action}${query}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...directoryHeaders(input.directory),
        },
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? String((body as { error: string }).error)
        : `mcp.${input.action} failed (${response.status})`;
      return { status: 'failed', error: message, httpStatus: response.status };
    }
    // Drain boolean/JSON body; status truth comes from Cap refresh GET /mcp.
    await response.json().catch(() => null);
    const runtime = await refreshLynxMcpServerStatus(runtimeFetch, {
      name,
      directory: input.directory,
      fallback,
    });
    return { status: 'ok', runtime };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

/** Cap `api.mcp.connect({ name })` → POST `/mcp/{name}/connect`. */
export function connectLynxMcp(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { name: string; directory?: string | null },
): Promise<LynxMcpActionResult> {
  return postLynxMcpAction(runtimeFetch, { ...input, action: 'connect' });
}

/** Cap `api.mcp.disconnect({ name })` → POST `/mcp/{name}/disconnect`. */
export function disconnectLynxMcp(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { name: string; directory?: string | null },
): Promise<LynxMcpActionResult> {
  return postLynxMcpAction(runtimeFetch, { ...input, action: 'disconnect' });
}

/**
 * Cap Switch onCheckedChange: checked → connect, unchecked → disconnect.
 * Returns action result; caller must reload sheet for honest status (never fake ON).
 */
export async function setLynxMcpConnected(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { name: string; directory?: string | null; connected: boolean },
): Promise<LynxMcpActionResult> {
  return input.connected
    ? connectLynxMcp(runtimeFetch, input)
    : disconnectLynxMcp(runtimeFetch, input);
}
