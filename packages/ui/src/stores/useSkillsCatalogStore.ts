import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import type {
  SkillsRepoScanRequest,
  SkillsRepoScanResponse,
  SkillsInstallRequest,
  SkillsInstallResponse,
  SkillsInstallError,
} from '@/lib/api/types';

import { refreshSkillsAfterOpenCodeRestart } from '@/stores/useSkillsStore';
import { startConfigUpdate, finishConfigUpdate, updateConfigUpdateMessage } from '@/lib/configUpdate';
import { queryClient } from '@/lib/queryRuntime';
import { FALLBACK_SKILLS_CATALOG_SOURCES, invalidateSkillsCatalogQueries } from '@/queries/skillsCatalogQueries';
import { refreshInstalledSkillsQuery } from '@/queries/installedSkillsQueries';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { opencodeClient } from '@/lib/opencode/client';

const getCurrentDirectory = (): string | null => {
  const opencodeDirectory = opencodeClient.getDirectory();
  if (typeof opencodeDirectory === 'string' && opencodeDirectory.trim().length > 0) {
    return opencodeDirectory;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__zustand_directory_store__;
    if (store) {
      return store.getState().currentDirectory;
    }
  } catch {
    // ignore
  }

  return null;
};

export interface SkillsCatalogState {
  selectedSourceId: string | null;
  isScanning: boolean;
  isInstalling: boolean;
  lastScanError: SkillsRepoScanResponse['error'] | null;
  lastInstallError: SkillsInstallError | null;
  scanResults: SkillsRepoScanResponse['items'] | null;
  setSelectedSource: (id: string | null) => void;
  scanRepo: (request: SkillsRepoScanRequest, options?: { directory?: string | null }) => Promise<SkillsRepoScanResponse>;
  installSkills: (request: SkillsInstallRequest, options?: { directory?: string | null; transportIdentity?: string }) => Promise<SkillsInstallResponse>;
}

export const useSkillsCatalogStore = create<SkillsCatalogState>()(
  devtools(
    (set) => ({
      selectedSourceId: FALLBACK_SKILLS_CATALOG_SOURCES[0]?.id ?? null,
      isScanning: false,
      isInstalling: false,
      lastScanError: null,
      lastInstallError: null,
      scanResults: null,
      setSelectedSource: (selectedSourceId) => set({ selectedSourceId }),
      scanRepo: async (request, options) => {
        set({ isScanning: true, lastScanError: null, scanResults: null });
        try {
          const hasDirectoryOverride = Boolean(options && Object.prototype.hasOwnProperty.call(options, 'directory'));
          const currentDirectory = hasDirectoryOverride
            ? (typeof options?.directory === 'string' ? options.directory.trim() || null : null)
            : getCurrentDirectory();
          const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';
          const response = await runtimeFetch(`/api/config/skills/scan${queryParams}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(request),
          });
          const payload = (await response.json().catch(() => null)) as SkillsRepoScanResponse | null;
          if (!response.ok || !payload) {
            const error = payload?.error || { kind: 'unknown', message: 'Failed to scan repository' };
            set({ lastScanError: error });
            return { ok: false, error };
          }
          if (!payload.ok) {
            set({ lastScanError: payload.error || { kind: 'unknown', message: 'Failed to scan repository' } });
            return payload;
          }
          set({ scanResults: payload.items || [] });
          return payload;
        } finally {
          set({ isScanning: false });
        }
      },
      installSkills: async (request, options) => {
        const hasDirectoryOverride = Boolean(options && Object.prototype.hasOwnProperty.call(options, 'directory'));
        const directory = hasDirectoryOverride
          ? (typeof options?.directory === 'string' ? options.directory.trim() || null : null)
          : getCurrentDirectory();
        const transport = options?.transportIdentity ?? getRuntimeTransportIdentity();
        if (getRuntimeTransportIdentity() !== transport) {
          return { ok: false, error: { kind: 'unknown', message: 'Failed to install skills' } as SkillsInstallError };
        }
        startConfigUpdate('Installing skills…');
        set({ isInstalling: true, lastInstallError: null });
        let requiresReload = false;
        try {
          const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
          const response = await runtimeFetch(`/api/config/skills/install${queryParams}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(request),
          });
          const payload = (await response.json().catch(() => null)) as SkillsInstallResponse | null;
          if (!payload) {
            const error = { kind: 'unknown', message: 'Failed to install skills' } as SkillsInstallError;
            set({ lastInstallError: error });
            updateConfigUpdateMessage('Failed to install skills. Please retry.');
            return { ok: false, error };
          }
          if (!response.ok || !payload.ok) {
            const error = payload.error || ({ kind: 'unknown', message: 'Failed to install skills' } as SkillsInstallError);
            set({ lastInstallError: error });
            updateConfigUpdateMessage(error.message || 'Failed to install skills. Please retry.');
            return { ok: false, error };
          }
          if (getRuntimeTransportIdentity() !== transport) return payload;

          if (payload.requiresReload) {
            requiresReload = true;
            await refreshSkillsAfterOpenCodeRestart({
              message: payload.message,
              delayMs: payload.reloadDelayMs,
              directory,
              transportIdentity: transport,
            });
          } else {
            updateConfigUpdateMessage(payload.message || 'Refreshing skills…');
            await refreshInstalledSkillsQuery(queryClient, directory, transport);
            await invalidateSkillsCatalogQueries(queryClient, directory, transport);
          }
          return payload;
        } catch (error) {
          const err = { kind: 'unknown', message: error instanceof Error ? error.message : String(error) } as SkillsInstallError;
          set({ lastInstallError: err });
          updateConfigUpdateMessage('Failed to install skills. Please retry.');
          return { ok: false, error: err };
        } finally {
          set({ isInstalling: false });
          if (!requiresReload) finishConfigUpdate();
        }
      },
    }),
    { name: 'skills-catalog-store' },
  ),
);
