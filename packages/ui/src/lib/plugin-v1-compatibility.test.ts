import { describe, expect, test } from 'bun:test'

import { isV1IncompatiblePlugin, type PluginV1Compatibility } from './plugin-v1-compatibility'

describe('V1 plugin settings mark (ticket 12)', () => {
  test('settings treat V1 plugins as incompatible, not a silent load miss', () => {
    expect(isV1IncompatiblePlugin({ compatibility: 'v1-incompatible', compatible: false })).toBe(true)
    // Unmarked records have no compatibility fields and must not be treated as V1-incompatible.
    const unmarkedPlugin: PluginV1Compatibility = {}
    expect(isV1IncompatiblePlugin(unmarkedPlugin)).toBe(false)
  })

  test('locale copy and settings UI surface the incompatible mark', async () => {
    const { settingsDict } = await import('./i18n/messages/en.settings')
    expect(settingsDict['settings.plugins.compatibility.v1Incompatible']).toBeTruthy()
    expect(settingsDict['settings.plugins.compatibility.v1Incompatible.tooltip']).toBeTruthy()
    expect(settingsDict['settings.plugins.registry.banner.v1Incompatible.title']).toBeTruthy()
    expect(settingsDict['settings.plugins.registry.banner.v1Incompatible.description']).toBeTruthy()

    const sidebar = await Bun.file(new URL('../components/sections/plugins/PluginsSidebar.tsx', import.meta.url)).text()
    const page = await Bun.file(new URL('../components/sections/plugins/PluginsPage.tsx', import.meta.url)).text()
    expect(sidebar).toMatch(/isV1IncompatiblePlugin|v1-incompatible|v1Incompatible/)
    expect(page).toMatch(/isV1IncompatiblePlugin|v1-incompatible|v1Incompatible/)
  })
})
