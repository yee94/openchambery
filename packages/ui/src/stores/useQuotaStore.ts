import React from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { ProviderResult, QuotaProviderId } from '@/types';
import { QUOTA_PROVIDERS } from '@/lib/quota';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getDefaultModels } from '@/lib/quota/model-families';
import { updateDesktopSettings } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { fetchQuotaProvider, isProviderResult, queryClient, queryKeys } from '@/lib/queryRuntime';

const DEFAULT_REFRESH_INTERVAL_MS = 60000;
let refreshGeneration = 0;
let quotaRuntimeGeneration = 0;
const providerFetchCounts = new Map<QuotaProviderId, number>();

interface QuotaSettingsState {
  autoRefresh: boolean;
  refreshIntervalMs: number;
  displayMode: 'usage' | 'remaining';
  showPredValues: boolean;
  dropdownProviderIds: QuotaProviderId[];
  selectedModels: Record<string, string[]>;  // Map of providerId -> selected model names
  expandedFamilies: Record<string, string[]>;  // Map of providerId -> EXPANDED family IDs (header dropdown - inverted)
}

interface QuotaStore extends QuotaSettingsState {
  results: ProviderResult[];
  selectedProviderId: QuotaProviderId | null;
  isLoading: boolean;
  isFetchingProvider: Record<string, boolean>;
  lastUpdated: number | null;
  error: string | null;

  loadSettings: () => Promise<void>;
  fetchAllQuotas: () => Promise<void>;
  fetchProviderQuota: (providerId: QuotaProviderId) => Promise<void>;
  setSelectedProvider: (providerId: QuotaProviderId | null) => void;
  setAutoRefresh: (enabled: boolean) => void;
  setRefreshInterval: (intervalMs: number) => void;
  setDisplayMode: (mode: 'usage' | 'remaining') => void;
  setShowPredValues: (enabled: boolean) => void;
  setDropdownProviderIds: (providerIds: QuotaProviderId[]) => void;
  setSelectedModels: (providerId: string, modelNames: string[]) => void;
  toggleModelSelected: (providerId: string, modelName: string) => void;
  setExpandedFamilies: (providerId: string, familyIds: string[]) => void;
  toggleFamilyExpanded: (providerId: string, familyId: string) => void;
  applyDefaultSelections: (providerId: string, availableModels: string[]) => void;
}

const parseSettings = (data: Record<string, unknown> | null): QuotaSettingsState => {
  const allProviderIds = QUOTA_PROVIDERS.map((provider) => provider.id);
  const autoRefresh = typeof data?.usageAutoRefresh === 'boolean'
    ? data.usageAutoRefresh
    : false;
  const refreshIntervalMs =
    typeof data?.usageRefreshIntervalMs === 'number' && Number.isFinite(data.usageRefreshIntervalMs)
      ? Math.max(30000, Math.min(300000, Math.round(data.usageRefreshIntervalMs)))
      : DEFAULT_REFRESH_INTERVAL_MS;

  const displayMode = data?.usageDisplayMode === 'remaining' ? 'remaining' : 'usage';
  const showPredValues = typeof data?.usageShowPredValues === 'boolean'
    ? data.usageShowPredValues
    : false;
  const rawDropdownProviders = Array.isArray(data?.usageDropdownProviders)
    ? data?.usageDropdownProviders
    : null;
  const dropdownProviderIds = rawDropdownProviders
    ? rawDropdownProviders.filter((entry): entry is QuotaProviderId =>
        typeof entry === 'string' && allProviderIds.includes(entry as QuotaProviderId)
      )
    : allProviderIds;

  // Parse selected models (providerId -> array of model names)
  const selectedModels: Record<string, string[]> = {};
  const rawSelectedModels = data?.usageSelectedModels;
  if (rawSelectedModels && typeof rawSelectedModels === 'object') {
    for (const [providerId, models] of Object.entries(rawSelectedModels)) {
      if (Array.isArray(models)) {
        selectedModels[providerId] = models.filter((m): m is string => typeof m === 'string');
      }
    }
  }

  // Parse expanded families (inverted collapsed logic for header dropdown)
  const expandedFamilies: Record<string, string[]> = {};
  const rawExpandedFamilies = data?.usageExpandedFamilies;
  if (rawExpandedFamilies && typeof rawExpandedFamilies === 'object') {
    for (const [providerId, families] of Object.entries(rawExpandedFamilies)) {
      if (Array.isArray(families)) {
        expandedFamilies[providerId] = families.filter((f): f is string => typeof f === 'string');
      }
    }
  }

  return {
    autoRefresh,
    refreshIntervalMs,
    displayMode,
    showPredValues,
    dropdownProviderIds,
    selectedModels,
    expandedFamilies,
  };
};

const loadSettingsFromRuntime = async (): Promise<QuotaSettingsState> => {
  const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
  if (runtimeSettings) {
    try {
      const result = await runtimeSettings.load();
      const settings = result?.settings as Record<string, unknown> | undefined;
      return parseSettings(settings ?? null);
    } catch {
      // fall through
    }
  }

  if (!isVSCodeRuntime()) {
    const response = await runtimeFetch('/api/config/settings', {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    if (response.ok) {
      const data = await response.json().catch(() => null);
      return parseSettings(data as Record<string, unknown> | null);
    }
  }

  return {
    autoRefresh: false,
    refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
    displayMode: 'usage',
    showPredValues: false,
    dropdownProviderIds: QUOTA_PROVIDERS.map((provider) => provider.id),
    selectedModels: {},
    expandedFamilies: {},
  };
};

type ProviderRefreshOutcome =
  | { providerId: QuotaProviderId; result: ProviderResult }
  | { providerId: QuotaProviderId; error: string }
  | { providerId: QuotaProviderId; stale: true };

const replaceProviderResult = (
  results: ProviderResult[],
  providerId: QuotaProviderId,
  result: unknown,
): ProviderResult[] => {
  const next = results.filter((entry) => entry?.providerId && entry.providerId !== providerId);
  if (isProviderResult(result)) next.push(result);
  return next;
};

const refreshProviderQuota = async (
  providerId: QuotaProviderId,
  set: (partial: Partial<QuotaStore> | ((state: QuotaStore) => Partial<QuotaStore>)) => void,
): Promise<ProviderRefreshOutcome> => {
  const runtimeGeneration = quotaRuntimeGeneration;
  providerFetchCounts.set(providerId, (providerFetchCounts.get(providerId) ?? 0) + 1);
  set((state) => ({
    isFetchingProvider: { ...state.isFetchingProvider, [providerId]: true },
  }));

  try {
    const result = await queryClient.fetchQuery({
      queryKey: queryKeys.quota(providerId),
      queryFn: ({ signal }) => fetchQuotaProvider(providerId, signal),
      staleTime: 0,
      retry: false,
    });
    if (runtimeGeneration !== quotaRuntimeGeneration) {
      return { providerId, stale: true };
    }
    if (!isProviderResult(result)) {
      throw new Error('Invalid quota response');
    }
    set((state) => ({ results: replaceProviderResult(state.results, providerId, result) }));
    return { providerId, result };
  } catch (error) {
    if (runtimeGeneration !== quotaRuntimeGeneration) {
      return { providerId, stale: true };
    }
    set((state) => {
      if (state.results.every((entry) => entry?.providerId)) return {};
      return { results: state.results.filter((entry) => entry?.providerId) };
    });
    return {
      providerId,
      error: error instanceof Error ? error.message : 'Failed to fetch quota',
    };
  } finally {
    if (runtimeGeneration === quotaRuntimeGeneration) {
      const remaining = (providerFetchCounts.get(providerId) ?? 1) - 1;
      if (remaining > 0) {
        providerFetchCounts.set(providerId, remaining);
      } else {
        providerFetchCounts.delete(providerId);
      }
      set((state) => ({
        isFetchingProvider: {
          ...state.isFetchingProvider,
          [providerId]: remaining > 0,
        },
      }));
    }
  }
};

export const resetQuotaStoreForRuntimeSwitch = (): void => {
  quotaRuntimeGeneration += 1;
  refreshGeneration += 1;
  providerFetchCounts.clear();
  useQuotaStore.setState({
    results: [],
    isLoading: false,
    isFetchingProvider: {},
    lastUpdated: null,
    error: null,
  });
};

export const useQuotaStore = create<QuotaStore>()(
  devtools(
    (set, get) => ({
      results: [],
      selectedProviderId: null,
      isLoading: false,
      isFetchingProvider: {},
      lastUpdated: null,
      error: null,
      autoRefresh: false,
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      displayMode: 'usage',
      showPredValues: false,
      dropdownProviderIds: QUOTA_PROVIDERS.map((provider) => provider.id),
      selectedModels: {},
      expandedFamilies: {},

      loadSettings: async () => {
        try {
          const settings = await loadSettingsFromRuntime();
          set(settings);
        } catch (error) {
          console.warn('Failed to load usage settings:', error);
        }
      },

      fetchAllQuotas: async () => {
        const generation = ++refreshGeneration;
        set({ isLoading: true, error: null });
        const providerIds = QUOTA_PROVIDERS.map((provider) => provider.id);
        const outcomes = await Promise.all(providerIds.map((providerId) => refreshProviderQuota(providerId, set)));
        if (generation === refreshGeneration) {
          const failed = outcomes.find((outcome): outcome is Extract<ProviderRefreshOutcome, { error: string }> => 'error' in outcome);
          const succeeded = outcomes.some((outcome) => 'result' in outcome);
          set({
            isLoading: false,
            ...(succeeded ? { lastUpdated: Date.now() } : {}),
            error: failed?.error ?? null,
          });
        }
      },

      fetchProviderQuota: async (providerId) => {
        const outcome = await refreshProviderQuota(providerId, set);
        if (!('stale' in outcome)) {
          set({ error: 'error' in outcome ? outcome.error : null });
        }
      },

      setSelectedProvider: (providerId) => set({ selectedProviderId: providerId }),
      setAutoRefresh: (enabled) => set({ autoRefresh: enabled }),
      setRefreshInterval: (intervalMs) => {
        const clamped = Math.max(30000, Math.min(300000, Math.round(intervalMs)));
        set({ refreshIntervalMs: clamped });
      },
      setDisplayMode: (mode) => set({ displayMode: mode }),
      setShowPredValues: (enabled) => set({ showPredValues: enabled }),
      setDropdownProviderIds: (providerIds) => set({ dropdownProviderIds: providerIds }),

      setSelectedModels: (providerId, modelNames) => {
        set((state) => ({
          selectedModels: { ...state.selectedModels, [providerId]: modelNames }
        }));
      },

      toggleModelSelected: (providerId, modelName) => {
        set((state) => {
          const currentSelected = state.selectedModels[providerId] ?? [];
          const isSelected = currentSelected.includes(modelName);
          const nextSelected = isSelected
            ? currentSelected.filter((m) => m !== modelName)
            : [...currentSelected, modelName];
          return {
            selectedModels: { ...state.selectedModels, [providerId]: nextSelected }
          };
        });
      },

      setExpandedFamilies: (providerId, familyIds) => {
        set((state) => ({
          expandedFamilies: { ...state.expandedFamilies, [providerId]: familyIds }
        }));
        // Persist
        void updateDesktopSettings({ usageExpandedFamilies: get().expandedFamilies });
      },

      toggleFamilyExpanded: (providerId, familyId) => {
        set((state) => {
          const currentExpanded = state.expandedFamilies[providerId] ?? [];
          const isExpanded = currentExpanded.includes(familyId);
          const nextExpanded = isExpanded
            ? currentExpanded.filter((id) => id !== familyId)
            : [...currentExpanded, familyId];
          return {
            expandedFamilies: { ...state.expandedFamilies, [providerId]: nextExpanded }
          };
        });
        // Persist
        void updateDesktopSettings({ usageExpandedFamilies: get().expandedFamilies });
      },

      applyDefaultSelections: (providerId, availableModels) => {
        const state = get();
        // Only apply if no prior selections exist
        if ((state.selectedModels[providerId]?.length ?? 0) > 0) return;

        const defaults = getDefaultModels(providerId as QuotaProviderId, availableModels);
        if (defaults.length === 0) return;

        set((s) => ({
          selectedModels: { ...s.selectedModels, [providerId]: defaults },
        }));
        // Persist
        void updateDesktopSettings({ usageSelectedModels: get().selectedModels });
      },
    }),
    { name: 'quota-store' }
  )
);

export const useQuotaAutoRefresh = () => {
  const autoRefresh = useQuotaStore((state) => state.autoRefresh);
  const refreshIntervalMs = useQuotaStore((state) => state.refreshIntervalMs);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);

  React.useEffect(() => {
    if (!autoRefresh) {
      return;
    }

    const interval = window.setInterval(() => {
      fetchAllQuotas();
    }, refreshIntervalMs);

    return () => window.clearInterval(interval);
  }, [autoRefresh, refreshIntervalMs, fetchAllQuotas]);
};
