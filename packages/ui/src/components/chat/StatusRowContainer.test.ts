import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

describe('StatusRowContainer source contracts', () => {
  const source = readFileSync(join(here, 'StatusRowContainer.tsx'), 'utf8')
  const messageListSource = readFileSync(join(here, 'MessageList.tsx'), 'utf8')

  test('hides generic busy assistant status until a concrete part exists', () => {
    // Matches ProgressiveGroup's zero-row live header gate: no tool/reasoning/text
    // part → no orphan "thinking / working" label.
    expect(source).toContain('const showAssistantStatus = working.isWaitingForPermission')
    expect(source).toContain('|| !working.isGenericStatus')
    expect(source).toContain('showAssistantStatus={showAssistantStatus}')
    expect(source).not.toMatch(/showAssistantStatus\s*\n\s*showTodos/)
  })

  test('classic live status slot mounts inside the markdown pin-reveal root', () => {
    expect(messageListSource).toContain('liveStatusSlot?: React.ReactNode')
    expect(messageListSource).toContain('{liveStatusSlot}')
    const pinRoot = messageListSource.indexOf('ref={setTanstackPinRoot}')
    const slot = messageListSource.indexOf('{liveStatusSlot}')
    const pinRootClose = messageListSource.indexOf('</div>', messageListSource.indexOf('<StreamingTailContent'))
    expect(pinRoot).toBeGreaterThan(-1)
    expect(slot).toBeGreaterThan(pinRoot)
    expect(slot).toBeLessThan(pinRootClose)
  })
})
