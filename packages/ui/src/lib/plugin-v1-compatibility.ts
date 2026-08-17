export const PLUGIN_COMPATIBILITY_V1_INCOMPATIBLE = 'v1-incompatible' as const

export type PluginV1Compatibility = {
  compatibility?: typeof PLUGIN_COMPATIBILITY_V1_INCOMPATIBLE | string
  compatible?: boolean
}

export function isV1IncompatiblePlugin(record: PluginV1Compatibility | null | undefined): boolean {
  if (!record) return false
  return record.compatibility === PLUGIN_COMPATIBILITY_V1_INCOMPATIBLE || record.compatible === false
}
