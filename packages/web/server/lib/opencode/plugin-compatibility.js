// V1 plugin API cannot run on opencode2. Settings must mark this explicitly
// instead of letting load fail silently.
export const PLUGIN_COMPATIBILITY_V1_INCOMPATIBLE = 'v1-incompatible';

export function pluginCompatibilityForV2() {
  return {
    compatibility: PLUGIN_COMPATIBILITY_V1_INCOMPATIBLE,
    compatible: false,
  };
}

export function withV1PluginIncompatibility(record) {
  if (!record || typeof record !== 'object') return record;
  return { ...record, ...pluginCompatibilityForV2() };
}
