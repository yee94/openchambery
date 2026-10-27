import { afterEach, expect, test, vi } from 'vitest'

const motion = vi.hoisted(() => ({ progress: null as ((value: number) => void) | null, complete: null as (() => void) | null }))
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>()
  return {
    cubicBezier: actual.cubicBezier,
    animate: (subject: unknown, _keyframes: unknown, options?: { onUpdate?: (value: number) => void; onComplete?: () => void }) => {
      if (typeof subject === 'number' && options?.onUpdate) {
        motion.progress = options.onUpdate
        motion.complete = options.onComplete ?? null
      }
      return { stop: vi.fn() }
    },
  }
})

import { captureContactSendFlightSource, startContactSendFlight } from './contactSendFlight'

const rect = (left: number, top: number, width: number, height: number) => () => DOMRect.fromRect({ x: left, y: top, width, height })

afterEach(() => { document.body.innerHTML = '' })

const mount = () => {
  document.body.innerHTML = `
    <div data-surface style="background-color: rgb(40, 40, 40); border-radius: 24px"><textarea style="padding: 12px"></textarea></div>
    <div data-bubble style="background-color: rgb(90, 140, 230); border-radius: 18px 18px 8px 18px; padding: 10px 16px">Ship it</div>`
  const surface = document.querySelector<HTMLElement>('[data-surface]')!
  const field = surface.querySelector('textarea')!
  const bubble = document.querySelector<HTMLElement>('[data-bubble]')!
  surface.getBoundingClientRect = rect(16, 900, 360, 48)
  field.getBoundingClientRect = rect(56, 900, 280, 48)
  bubble.getBoundingClientRect = rect(290, 600, 90, 44)
  field.value = 'Ship it'
  return { surface, field, bubble }
}

const overlay = () => document.querySelector<HTMLElement>('[data-assistant-contact-send-flight]')!
const frame = () => {
  const [, x, y] = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(overlay().style.transform) ?? []
  return { left: Number(x), top: Number(y), width: Number.parseFloat(overlay().style.width), height: Number.parseFloat(overlay().style.height) }
}

test('morphs from the composer shape into the bubble shape on split axes', () => {
  const { surface, field, bubble } = mount()
  const source = captureContactSendFlightSource(surface, field)!
  const stop = startContactSendFlight(source, bubble)

  expect(bubble.style.visibility).toBe('hidden')
  expect(overlay().style.backgroundColor).toBe('rgb(40, 40, 40)')
  expect(overlay().children).toHaveLength(2)
  expect(Array.from(overlay().children).every((node) => !(node as HTMLElement).style.backgroundColor)).toBe(true)
  expect(frame()).toEqual({ left: 16, top: 900, width: 360, height: 48 })
  expect(overlay().style.borderRadius).toBe('24px')

  motion.progress!(0.5)
  const mid = frame()
  // Horizontal edges lead on the fast ease-out; the bottom edge trails on the slow vertical curve.
  const horizontal = (360 - mid.width) / (360 - 90)
  const vertical = (948 - (mid.top + mid.height)) / (948 - 644)
  expect(horizontal).toBeGreaterThan(0.9)
  expect(vertical).toBeGreaterThan(0.3)
  expect(vertical).toBeLessThan(horizontal)

  motion.progress!(1)
  expect(frame()).toEqual({ left: 290, top: 600, width: 90, height: 44 })
  expect(overlay().style.borderRadius).toBe('18px 18px 8px')

  motion.complete!()
  expect(document.querySelector('[data-assistant-contact-send-flight]')).toBeNull()
  expect(bubble.style.visibility).toBe('')
  stop()
})

test('lands on the bubble wherever the follow scroll moved it', () => {
  const { surface, field, bubble } = mount()
  startContactSendFlight(captureContactSendFlightSource(surface, field)!, bubble)
  bubble.getBoundingClientRect = rect(290, 820, 90, 44)
  motion.progress!(1)
  expect(frame()).toEqual({ left: 290, top: 820, width: 90, height: 44 })
})

test('stop removes the overlay and reveals the bubble', () => {
  const { surface, field, bubble } = mount()
  const settled = vi.fn()
  const stop = startContactSendFlight(captureContactSendFlightSource(surface, field)!, bubble, bubble, settled)
  expect(settled).not.toHaveBeenCalled()
  motion.complete!()
  stop()
  stop()
  expect(settled).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[data-assistant-contact-send-flight]')).toBeNull()
  expect(bubble.style.visibility).toBe('')
})

test('an empty field captures nothing', () => {
  const { surface, field } = mount()
  field.value = '   '
  expect(captureContactSendFlightSource(surface, field)).toBeNull()
})

test('desktop starts near the typed text with a content-sized shell instead of the full composer', () => {
  const { surface, field, bubble } = mount()
  const source = captureContactSendFlightSource(surface, field, true)!
  startContactSendFlight(source, bubble)
  expect(frame().width).toBe(122)
  expect(frame().left).toBe(source.textBox.left - 16)
  motion.progress!(1)
  expect(frame()).toEqual({ left: 290, top: 600, width: 90, height: 44 })
})
