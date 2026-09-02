import { useEvent } from '@reactuses/core';
import { useState, useEffect, useMemo } from 'react';
import { getModelBrandLogoCandidates, resolveModelBrand } from '@/lib/modelBrand';

interface UseModelLogoReturn {
  src: string | null;
  onError: () => void;
  hasLogo: boolean;
  brand: string | null;
}

const modelLogoModules = import.meta.glob<string>('../assets/model-icons/*.{svg,png}', {
  eager: true,
  import: 'default',
});

const providerLogoModules = import.meta.glob<string>('../assets/provider-logos/*.svg', {
  eager: true,
  import: 'default',
});

const LOCAL_MODEL_LOGO_MAP = new Map<string, string>();
const LOCAL_PROVIDER_LOGO_MAP = new Map<string, string>();
const PRELOADED_LOGO_SRCS = new Set<string>();

const LOGO_ALIAS = new Map<string, string>([
  ['codex', 'openai'],
  ['chatgpt', 'openai'],
  ['claude', 'anthropic'],
  ['gemini', 'google'],
  ['evroc-ai', 'evroc'],
  ['evrocai', 'evroc'],
  ['ollama-cloud', 'ollama'],
  ['opencode-go', 'opencode'],
  ['wafer-ai', 'wafer.ai'],
  ['wafer', 'wafer.ai'],
  ['zai-coding-plan', 'zai'],
  ['zhipuai-coding-plan', 'zhipuai'],
  ['api-for-cursor', 'cursor'],
]);

// Prefer PNG over SVG when both exist for the same stem (official raster marks
// like Grok need the pixel-accurate asset, not a simplified path SVG).
const modelLogoEntries = Object.entries(modelLogoModules).sort(([a], [b]) => {
  const aPng = a.toLowerCase().endsWith('.png') ? 1 : 0;
  const bPng = b.toLowerCase().endsWith('.png') ? 1 : 0;
  return aPng - bPng;
});
for (const [path, url] of modelLogoEntries) {
  const match = path.match(/model-icons\/([^/]+)\.(?:svg|png)$/i);
  if (match?.[1] && url) {
    LOCAL_MODEL_LOGO_MAP.set(match[1].toLowerCase(), url);
  }
}

for (const [path, url] of Object.entries(providerLogoModules)) {
  const match = path.match(/provider-logos\/([^/]+)\.svg$/i);
  if (match?.[1] && url) {
    LOCAL_PROVIDER_LOGO_MAP.set(match[1].toLowerCase(), url);
  }
}

const normalizeProviderId = (providerId: string | null | undefined) => {
  return (providerId ?? '')
    .toLowerCase()
    .trim()
    .replace(/^models\./, '')
    .replace(/^provider\./, '')
    .replace(/\s+/g, '-');
};

const buildProviderLogoCandidates = (providerId: string | null | undefined): string[] => {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) return [];

  const compact = normalized.replace(/[^a-z0-9_\-./:]/g, '');
  const primary = compact.split(/[/:]/)[0] || compact;
  const candidates = [LOGO_ALIAS.get(compact), LOGO_ALIAS.get(primary), compact, primary].filter(
    (value): value is string => Boolean(value && value.length > 0),
  );

  return [...new Set(candidates)];
};

/** 构建有序 logo URL 列表：本地 model → 品牌对应的本地 provider → Provider 对应的本地 logo */
const buildLogoSrcChain = (
  modelId: string | null | undefined,
  providerId?: string | null,
): { brand: string | null; chain: string[] } => {
  const brand = resolveModelBrand(modelId, providerId);
  const brandCandidates = getModelBrandLogoCandidates(brand);
  const providerCandidates = buildProviderLogoCandidates(providerId);
  const chain: string[] = [];

  for (const candidate of brandCandidates) {
    const localModel = LOCAL_MODEL_LOGO_MAP.get(candidate);
    if (localModel) chain.push(localModel);
  }

  for (const candidate of brandCandidates) {
    const localProvider = LOCAL_PROVIDER_LOGO_MAP.get(candidate);
    if (localProvider) chain.push(localProvider);
  }

  for (const candidate of providerCandidates) {
    const localProvider = LOCAL_PROVIDER_LOGO_MAP.get(candidate);
    if (localProvider) chain.push(localProvider);
  }

  return { brand, chain: [...new Set(chain)] };
};

/** First local logo URL for a model, or null when no bundled mark exists. */
export const resolveModelLogoSrc = (
  modelId: string | null | undefined,
  providerId?: string | null,
): string | null => buildLogoSrcChain(modelId, providerId).chain[0] ?? null;

const preloadModelLogo = (modelId: string | null | undefined, providerId?: string | null): void => {
  if (typeof Image === 'undefined') return;
  const { chain } = buildLogoSrcChain(modelId, providerId);
  const src = chain[0];
  if (!src || PRELOADED_LOGO_SRCS.has(src)) return;

  PRELOADED_LOGO_SRCS.add(src);
  const image = new Image();
  image.decoding = 'async';
  image.onerror = () => {
    PRELOADED_LOGO_SRCS.delete(src);
  };
  image.src = src;
  void image.decode?.().catch(() => undefined);
};

export const preloadModelLogos = (
  entries: readonly { modelId?: string | null; providerId?: string | null }[],
): void => {
  for (const entry of entries) {
    preloadModelLogo(entry.modelId, entry.providerId);
  }
};

/**
 * 按模型名解析品牌 logo；聚合 Provider 下显示真实模型品牌而非渠道图标。
 */
export function useModelLogo(
  modelId: string | null | undefined,
  providerId?: string | null,
): UseModelLogoReturn {
  const { brand, chain } = useMemo(
    () => buildLogoSrcChain(modelId, providerId),
    [modelId, providerId],
  );

  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [modelId, providerId]);

  const handleError = useEvent(() => {
    setIndex((current) => {
      const next = current + 1;
      return next < chain.length ? next : chain.length;
    });
  });

  const src = index < chain.length ? chain[index] ?? null : null;

  return {
    src,
    onError: handleError,
    hasLogo: Boolean(src),
    brand,
  };
}
