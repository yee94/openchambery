export interface ParsedModelIdentifier {
  providerId: string;
  modelId: string;
  variant?: string;
}

export const parseModelIdentifier = (value: unknown): ParsedModelIdentifier | null => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const model = value as Record<string, unknown>;
    if (typeof model.providerID !== 'string' || typeof model.model !== 'string') return null;
    if (model.providerID.includes('/') || model.model.includes('#')) return null;
    if (model.variant !== undefined && typeof model.variant !== 'string') return null;
    return parseModelIdentifier(`${model.providerID}/${model.model}${model.variant === undefined ? '' : `#${model.variant}`}`);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const separatorIndex = text.indexOf('/');
  if (separatorIndex <= 0) return null;
  const [modelId, variant, extra] = text.slice(separatorIndex + 1).split('#');
  const providerId = text.slice(0, separatorIndex);
  if (!modelId || /[\s#]/u.test(providerId) || /\s/u.test(modelId)
    || extra !== undefined || (variant !== undefined && (!variant || /\s/u.test(variant)))) return null;
  return { providerId, modelId, ...(variant === undefined ? {} : { variant }) };
};

export const normalizeModelIdentifier = (value: unknown): string | undefined => {
  const model = parseModelIdentifier(value);
  return model ? `${model.providerId}/${model.modelId}${model.variant ? `#${model.variant}` : ''}` : undefined;
};
