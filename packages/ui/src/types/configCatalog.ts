export type ConfigCatalogCapabilities = {
  temperature?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  toolcall?: boolean;
  input?: Partial<Record<ConfigCatalogModality, boolean>>;
  output?: Partial<Record<ConfigCatalogModality, boolean>>;
};

export type ConfigCatalogModality = 'text' | 'audio' | 'image' | 'video' | 'pdf';

export type ConfigCatalogModel = {
  id: string;
  name: string;
  capabilities?: ConfigCatalogCapabilities;
  cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
  limit?: { context?: number; output?: number };
  release_date?: string;
  variants?: Record<string, object>;
};

export type ConfigCatalogProvider = {
  id: string;
  name: string;
  models: Record<string, ConfigCatalogModel>;
};

export type ProviderCatalog = {
  schemaVersion: 1;
  providers: ConfigCatalogProvider[];
  default: Record<string, string>;
  partial: boolean;
};
