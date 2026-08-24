import React from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import type { ConfigCatalogModel, ConfigCatalogProvider } from '@/types/configCatalog';

type ProviderModel = ConfigCatalogModel;
type ProviderWithModelList = Omit<ConfigCatalogProvider, 'models'> & { models: ProviderModel[] };

export interface ModelListItem {
  provider: ProviderWithModelList;
  model: ProviderModel;
  providerID: string;
  modelID: string;
}

export interface UseModelListsOptions {
  /** Session/current selection — pinned to the top of recent when not already a favorite. */
  currentProviderID?: string | null;
  currentModelID?: string | null;
}

function resolveListItem(
  providers: ProviderWithModelList[],
  hiddenModels: Array<{ providerID: string; modelID: string }>,
  providerID: string,
  modelID: string,
): ModelListItem | null {
  const provider = providers.find((p) => p.id === providerID);
  if (!provider) return null;
  const providerModels = Array.isArray(provider.models) ? provider.models : [];
  const model = providerModels.find((m: ProviderModel) => m.id === modelID);
  if (!model) return null;
  if (hiddenModels.some((item) => item.providerID === providerID && item.modelID === modelID)) {
    return null;
  }
  return { provider, model, providerID, modelID };
}

export const useModelLists = (options?: UseModelListsOptions) => {
  const providers = useConfigStore((state) => state.providers);
  const favoriteModels = useUIStore((state) => state.favoriteModels);
  const recentModels = useUIStore((state) => state.recentModels);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const currentProviderID = options?.currentProviderID ?? null;
  const currentModelID = options?.currentModelID ?? null;

  const favoriteModelsList = React.useMemo(() => {
    return favoriteModels
      .map(({ providerID, modelID }) => resolveListItem(providers, hiddenModels, providerID, modelID))
      .filter((item): item is ModelListItem => item !== null);
  }, [favoriteModels, providers, hiddenModels]);

  const recentModelsList = React.useMemo(() => {
    const list = recentModels
      .map(({ providerID, modelID }) => resolveListItem(providers, hiddenModels, providerID, modelID))
      .filter((item): item is ModelListItem => item !== null)
      .filter(({ providerID, modelID }) =>
        !favoriteModels.some(fav => fav.providerID === providerID && fav.modelID === modelID)
      );

    if (!currentProviderID || !currentModelID) return list;

    const isFavorite = favoriteModels.some(
      (fav) => fav.providerID === currentProviderID && fav.modelID === currentModelID,
    );
    if (isFavorite) return list;

    const existingIndex = list.findIndex(
      (item) => item.providerID === currentProviderID && item.modelID === currentModelID,
    );
    if (existingIndex === 0) return list;
    if (existingIndex > 0) {
      const next = list.slice();
      const [item] = next.splice(existingIndex, 1);
      next.unshift(item);
      return next;
    }

    const currentItem = resolveListItem(providers, hiddenModels, currentProviderID, currentModelID);
    if (!currentItem) return list;
    return [currentItem, ...list];
  }, [recentModels, favoriteModels, providers, hiddenModels, currentProviderID, currentModelID]);

  return { favoriteModelsList, recentModelsList };
};
