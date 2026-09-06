/**
 * Cap AgentSelector / MobileModelPickerPanel spirit for Lynx composer.
 *
 * Lists agents from Cap `/api/agent` and models from `/api/config/providers`.
 * Selecting updates the composer session agent/model used by prompt_async —
 * there is no separate PATCH session agent route (Cap selection store + send).
 *
 * Sheets are MobileResizableSheet-like overlays; autocomplete stays ABOVE glass.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { loadAgentsCatalog, type LynxCatalogItem, type LynxCatalogLoadResult } from '../settings/catalogs';
import type { LynxComposerModel } from './composerActions';
import { loadLynxComposerCatalogs } from './composerCatalog';

export type LynxComposerPickerKind = 'agent' | 'model';

export type LynxComposerPickerItem = {
  id: string;
  title: string;
  subtitle?: string;
};

export type LynxComposerPickerLoadResult =
  | { status: 'ok'; items: LynxComposerPickerItem[] }
  | { status: 'no-runtime' }
  | { status: 'unsupported' }
  | { status: 'failed'; error: string };

const toPickerItems = (result: LynxCatalogLoadResult): LynxComposerPickerLoadResult => {
  if (result.status === 'ok') {
    return {
      status: 'ok',
      items: result.items.map((item: LynxCatalogItem) => ({
        id: item.id,
        title: item.title,
        ...(item.subtitle ? { subtitle: item.subtitle } : {}),
      })),
    };
  }
  if (result.status === 'no-runtime') return { status: 'no-runtime' };
  if (result.status === 'unsupported') return { status: 'unsupported' };
  return {
    status: 'failed',
    error: result.error.message,
  };
};

/** Agents for Cap AgentSelector sheet — GET `/api/agent`. */
export const loadLynxAgentPickerItems = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { directory?: string | null; signal?: AbortSignal },
): Promise<LynxComposerPickerLoadResult> => (
  toPickerItems(await loadAgentsCatalog(runtimeFetch, options))
);

/** Models for Cap MobileModelPickerPanel spirit — GET `/api/config/providers`. */
export const loadLynxModelPickerItems = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { directory?: string | null; signal?: AbortSignal },
): Promise<LynxComposerPickerLoadResult> => {
  const bundle = await loadLynxComposerCatalogs(runtimeFetch, options);
  return toPickerItems(bundle.models);
};

/** Cap model row id is `providerID/modelID`. */
export const parseLynxModelPickerId = (
  id: string,
): { providerID: string; modelID: string } | null => {
  const trimmed = id.trim();
  const idx = trimmed.indexOf('/');
  if (idx <= 0 || idx >= trimmed.length - 1) return null;
  const providerID = trimmed.slice(0, idx).trim();
  const modelID = trimmed.slice(idx + 1).trim();
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
};

export const applyLynxAgentPickerSelection = (
  current: LynxComposerModel,
  agentName: string | null | undefined,
): LynxComposerModel => {
  const name = typeof agentName === 'string' ? agentName.trim() : '';
  if (!name) {
    const { agent: _drop, ...rest } = current;
    void _drop;
    return { ...rest };
  }
  return { ...current, agent: name };
};

export const applyLynxModelPickerSelection = (
  current: LynxComposerModel,
  selection: { providerID: string; modelID: string; variant?: string },
): LynxComposerModel => {
  const providerID = selection.providerID.trim();
  const modelID = selection.modelID.trim();
  if (!providerID || !modelID) return current;
  const next: LynxComposerModel = {
    ...current,
    providerID,
    modelID,
  };
  if (selection.variant !== undefined) {
    const variant = selection.variant.trim();
    if (variant) next.variant = variant;
    else {
      const { variant: _drop, ...rest } = next;
      void _drop;
      return rest;
    }
  } else {
    // Cap clears previous variant when the model changes without a new variant.
    const { variant: _drop, ...rest } = next;
    void _drop;
    return rest;
  }
  return next;
};

export const filterLynxComposerPickerItems = (
  items: readonly LynxComposerPickerItem[],
  query: string,
): LynxComposerPickerItem[] => {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, 64);
  return items
    .filter((item) => (
      item.title.toLowerCase().includes(q)
      || item.id.toLowerCase().includes(q)
      || (item.subtitle?.toLowerCase().includes(q) ?? false)
    ))
    .slice(0, 64);
};

export const LYNX_COMPOSER_PICKER_SHEETS = {
  /** Cap MobileResizableSheet spirit — bottom half-height overlay, not glass contentView child. */
  placement: 'overlay-sheet' as const,
  /** Not a full-screen opaque surface.background page. */
  fullScreenOpaque: false as const,
  halfHeight: true as const,
  grabber: true as const,
  dismissVertical: true as const,
  /** Agent · model triggers stay inside glass; sheets open outside glass tree. */
  triggersInsideGlass: true as const,
  sheetsInsideGlassContentView: false as const,
  agentCatalogPath: '/api/agent' as const,
  modelCatalogPath: '/api/config/providers' as const,
  /** Selection feeds prompt_async body (no separate session PATCH). */
  appliesViaPromptAsync: true as const,
} as const;

export const LYNX_COMPOSER_PICKER_WIRING_NOTES = [
  'Agent picker lists Cap GET /api/agent; model picker lists GET /api/config/providers.',
  'Expanded footer Agent · model open half-height MobileResizableSheet (grabber + vertical dismiss) — not full-screen surface.background.',
  'Selecting updates composer session agent/model used by prompt_async — never fake-success.',
  'Sheets stay outside LynxComposerGlassCard; autocomplete remains ABOVE glass.',
  'Linux JS wiring only — host Mode B overlay / live UIGlassEffect / 真机 still residual. NOT DONE.',
] as const;
