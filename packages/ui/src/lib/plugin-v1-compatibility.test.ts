import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

import { isV1IncompatiblePlugin, type PluginV1Compatibility } from './plugin-v1-compatibility'

const readHere = (rel: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), 'utf8')

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

    const sidebar = readHere('../components/sections/plugins/PluginsSidebar.tsx')
    const page = readHere('../components/sections/plugins/PluginsPage.tsx')
    expect(sidebar).toMatch(/isV1IncompatiblePlugin|v1-incompatible|v1Incompatible/)
    expect(page).toMatch(/isV1IncompatiblePlugin|v1-incompatible|v1Incompatible/)
  })
})
