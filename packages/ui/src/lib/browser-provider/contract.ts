/**
 * UI seam for the extension browser host (ticket 05).
 *
 * The host owns discovery, selection persistence, action routing, and the
 * live surface. This module only describes that contract and rejects shapes
 * that would look like a connected browser when nothing is actually listed.
 */

export const BROWSER_PROVIDER_CATALOG_PATH = '/api/browser-providers';
export const BROWSER_PROVIDER_SELECTION_PATH = '/api/browser-providers/selection';

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NAME_MAX = 200;

export type BrowserProviderSummary = {
  id: string;
  name: string;
  /** Host can push a live picture for this provider. */
  surface: boolean;
};

export type BrowserProviderCatalog = {
  providers: BrowserProviderSummary[];
  /** Null unless it names a provider in `providers`. */
  selectedId: string | null;
};

export type SurfaceController = 'none' | 'agent' | 'user';
export type SurfaceEndedReason = 'service-stopped' | 'extension-unavailable' | 'host-shutdown';
export type SurfaceFrameMime = 'image/jpeg' | 'image/png';

export type SurfaceModifiers = {
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
};

export type SurfaceInputEvent =
  | {
    type: 'pointer';
    action: 'down' | 'up' | 'move';
    x: number;
    y: number;
    button: number;
    buttons: number;
    modifiers: SurfaceModifiers;
  }
  | {
    type: 'wheel';
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
    modifiers: SurfaceModifiers;
  }
  | {
    type: 'key';
    action: 'down' | 'up';
    key: string;
    code: string;
    modifiers: SurfaceModifiers;
  }
  | { type: 'text'; text: string };

export type SurfaceViewerMessage =
  | { type: 'ack'; seq: number }
  | { type: 'input'; events: SurfaceInputEvent[] }
  | { type: 'release' }
  | { type: 'resize'; width: number; height: number };

export type SurfaceFrameMessage = {
  type: 'frame';
  seq: number;
  width: number;
  height: number;
  mime: SurfaceFrameMime;
  bytes: number;
  title?: string;
  agentActive: boolean;
};

export type SurfaceHostMessage =
  | { type: 'hello'; viewerId: string }
  | SurfaceFrameMessage
  | { type: 'control'; controller: SurfaceController; mine: boolean }
  | { type: 'resized'; width: number; height: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'ended'; reason: SurfaceEndedReason };

export const browserProviderSurfacePath = (id: string): string =>
  `/api/browser-providers/${encodeURIComponent(id)}/surface/ws`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readProviderId = (value: unknown): string | null =>
  typeof value === 'string' && PROVIDER_ID_PATTERN.test(value) ? value : null;

const readProvider = (value: unknown): BrowserProviderSummary | null => {
  if (!isRecord(value)) return null;
  const id = readProviderId(value.id);
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!id || !name || name.length > NAME_MAX) return null;
  return {
    id,
    name,
    surface: value.surface === true,
  };
};

/**
 * A catalog the settings page and rail can trust.
 * A selected id that is not in the list is dropped, never shown as connected.
 * Malformed payloads return null so callers treat them as failure, not as an
 * empty connected browser.
 */
export const parseBrowserProviderCatalog = (payload: unknown): BrowserProviderCatalog | null => {
  if (!isRecord(payload) || !Array.isArray(payload.providers)) return null;
  const providers: BrowserProviderSummary[] = [];
  const seen = new Set<string>();
  for (const entry of payload.providers) {
    const provider = readProvider(entry);
    if (!provider || seen.has(provider.id)) continue;
    seen.add(provider.id);
    providers.push(provider);
  }
  const selectedId = readProviderId(payload.selectedId);
  return {
    providers,
    selectedId: selectedId && seen.has(selectedId) ? selectedId : null,
  };
};

export const parseBrowserProviderSelection = (payload: unknown): { selectedId: string } | null => {
  if (!isRecord(payload)) return null;
  const selectedId = readProviderId(payload.selectedId);
  return selectedId ? { selectedId } : null;
};

export const selectedBrowserProvider = (
  catalog: BrowserProviderCatalog | null | undefined,
): BrowserProviderSummary | null => {
  if (!catalog?.selectedId) return null;
  return catalog.providers.find((provider) => provider.id === catalog.selectedId) ?? null;
};

/** Settings select is shown only when the host listed at least one provider. */
export const shouldShowBrowserProviderSettings = (
  catalog: BrowserProviderCatalog | null | undefined,
): boolean => Boolean(catalog && catalog.providers.length > 0);

/** Rail is shown only for a selected provider that is still in the catalog. */
export const shouldShowBrowserProviderRail = (
  catalog: BrowserProviderCatalog | null | undefined,
): boolean => selectedBrowserProvider(catalog) !== null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const readSurfaceHostMessage = (payload: unknown): SurfaceHostMessage | null => {
  if (!isRecord(payload) || typeof payload.type !== 'string') return null;
  if (payload.type === 'hello' && typeof payload.viewerId === 'string' && payload.viewerId.length > 0) {
    return { type: 'hello', viewerId: payload.viewerId };
  }
  if (payload.type === 'frame') {
    const mime = payload.mime === 'image/jpeg' || payload.mime === 'image/png' ? payload.mime : null;
    if (!mime || !isFiniteNumber(payload.seq) || !isFiniteNumber(payload.width) || !isFiniteNumber(payload.height)) return null;
    if (!isFiniteNumber(payload.bytes) || payload.bytes < 1 || typeof payload.agentActive !== 'boolean') return null;
    const title = typeof payload.title === 'string' ? payload.title : undefined;
    return {
      type: 'frame',
      seq: payload.seq,
      width: payload.width,
      height: payload.height,
      mime,
      bytes: payload.bytes,
      title,
      agentActive: payload.agentActive,
    };
  }
  if (payload.type === 'control') {
    const controller = payload.controller === 'none' || payload.controller === 'agent' || payload.controller === 'user'
      ? payload.controller
      : null;
    if (!controller || typeof payload.mine !== 'boolean') return null;
    return { type: 'control', controller, mine: payload.mine };
  }
  if (payload.type === 'resized' && isFiniteNumber(payload.width) && isFiniteNumber(payload.height)) {
    return { type: 'resized', width: payload.width, height: payload.height };
  }
  if (payload.type === 'error' && typeof payload.code === 'string' && typeof payload.message === 'string') {
    return { type: 'error', code: payload.code, message: payload.message };
  }
  if (
    payload.type === 'ended'
    && (payload.reason === 'service-stopped' || payload.reason === 'extension-unavailable' || payload.reason === 'host-shutdown')
  ) {
    return { type: 'ended', reason: payload.reason };
  }
  return null;
};


