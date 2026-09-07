import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { useAssistantContactAutoFollow } from './useAssistantContactAutoFollow'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Geometry = {
  top: number
  height: number
  client: number
  writes: number
}

class TestResizeObserver {
  static instances: TestResizeObserver[] = []

  readonly observed = new Set<Element>()
  readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    TestResizeObserver.instances.push(this)
  }

  observe(target: Element) {
    this.observed.add(target)
  }

  unobserve(target: Element) {
    this.observed.delete(target)
  }

  disconnect() {
    this.observed.clear()
  }

  static emit(target: Element) {
    for (const observer of TestResizeObserver.instances) {
      if (!observer.observed.has(target)) continue
      observer.callback([], observer as unknown as ResizeObserver)
    }
  }
}

type ProbeProps = {
  active: boolean
  assistantID: string
  revision: number
  geometry: Geometry
  nodeKey?: string
}

const Probe: React.FC<ProbeProps> = ({ active, assistantID, revision, geometry, nodeKey }) => {
  const { scrollRef, contentRef } = useAssistantContactAutoFollow({
    active,
    assistantID,
    contentRevision: revision,
  })
  const attachScroller = React.useMemo<React.RefCallback<HTMLDivElement>>(() => (node) => {
    if (node && !Object.prototype.hasOwnProperty.call(node, 'scrollHeight')) {
      Object.defineProperties(node, {
        clientHeight: { configurable: true, get: () => geometry.client },
        scrollHeight: { configurable: true, get: () => geometry.height },
        scrollTop: {
          configurable: true,
          get: () => geometry.top,
          set: (value: number) => {
            geometry.writes += 1
            geometry.top = Math.max(0, Math.min(value, geometry.height - geometry.client))
          },
        },
      })
    }
    scrollRef(node)
  }, [geometry, scrollRef])

  return (
    <div key={nodeKey} ref={attachScroller} data-test-scroller="">
      <div ref={contentRef} data-test-content="">
        <div data-test-nested="" />
      </div>
    </div>
  )
}

const mountedRoots: Array<{ root: ReturnType<typeof createRoot>; host: HTMLDivElement }> = []
const originalResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  TestResizeObserver.instances = []
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver
})

afterEach(async () => {
  for (const mounted of mountedRoots.splice(0)) {
    await act(async () => { mounted.root.unmount() })
    mounted.host.remove()
  }
  globalThis.ResizeObserver = originalResizeObserver
})

const mountProbe = async (initial: ProbeProps) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mountedRoots.push({ root, host })
  let props = initial
  await act(async () => { root.render(<Probe {...props} />) })
  const scroller = host.querySelector<HTMLElement>('[data-test-scroller]')
  const content = host.querySelector<HTMLElement>('[data-test-content]')
  const nested = host.querySelector<HTMLElement>('[data-test-nested]')
  if (!scroller || !content || !nested) throw new Error('auto-follow probe missing')
  return {
    scroller,
    content,
    nested,
    render: async (patch: Partial<ProbeProps>) => {
      props = { ...props, ...patch }
      await act(async () => { root.render(<Probe {...props} />) })
    },
  }
}

const wheel = (target: Element, deltaY: number) => {
  target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY }))
}

const touch = (target: Element, type: string, clientY?: number, clientX = 20) => {
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, 'touches', {
    value: {
      item: (index: number) => index === 0 && clientY !== undefined ? { clientY, clientX } : null,
    },
  })
  target.dispatchEvent(event)
}

describe('useAssistantContactAutoFollow', () => {
  test.each(['scrollbar', 'wheel', 'previous touch', 'touch pointer'] as const)(
    'keeps 599 with zero writes through no-growth layout, late scroll and growth after %s intent', async (input) => {
      const geometry: Geometry = { top: 600, height: 900, client: 300, writes: 0 }
      const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })
      if (input === 'wheel') wheel(probe.scroller, 40)
      else if (input === 'previous touch') {
        touch(probe.scroller, 'touchstart', 200)
        touch(probe.scroller, 'touchmove', 190)
        touch(probe.scroller, 'touchend')
      } else probe.scroller.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerType: input === 'scrollbar' ? 'mouse' : 'touch',
      }))
      touch(probe.scroller, 'touchstart', 100)
      touch(probe.scroller, 'touchmove', 101)
      geometry.top = 599
      await probe.render({ revision: 1 })
      expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 599, writes: 0 })
      probe.scroller.dispatchEvent(new Event('scroll'))
      geometry.height = 960
      await probe.render({ revision: 2 })
      TestResizeObserver.emit(probe.content)
      expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 599, writes: 0 })
    },
  )

  test.each(['up', 'zero', 'touch reversal'] as const)('requires real downward movement to resume after %s movement near bottom', async (input) => {
    const geometry: Geometry = { top: 600, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })
    wheel(probe.scroller, -1)
    if (input === 'touch reversal') {
      touch(probe.scroller, 'touchstart', 100)
      touch(probe.scroller, 'touchmove', 90)
      touch(probe.scroller, 'touchmove', 91)
    } else wheel(probe.scroller, 1)
    geometry.top = input === 'zero' ? 600 : 599
    probe.scroller.dispatchEvent(new Event('scroll'))
    geometry.height = 960
    await probe.render({ revision: 1 })
    expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: input === 'zero' ? 600 : 599, writes: 0 })
  })

  test.each(['wheel', 'keyboard', 'scrollbar'] as const)('resumes on real downward arrival within bottom tolerance (%s)', async (input) => {
    const geometry: Geometry = { top: 600, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })
    if (input === 'scrollbar') probe.scroller.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    else wheel(probe.scroller, -1)
    geometry.top = 598
    probe.scroller.dispatchEvent(new Event('scroll'))
    geometry.top = 597
    probe.scroller.dispatchEvent(new Event('scroll'))
    geometry.height = 920
    await probe.render({ revision: 1 })
    expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 597, writes: 0 })
    if (input === 'wheel') wheel(probe.scroller, 40)
    if (input === 'keyboard') probe.scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    geometry.top = 619
    probe.scroller.dispatchEvent(new Event('scroll'))
    geometry.height = 960
    await probe.render({ revision: 2 })
    expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 660, writes: 1 })
  })

  test.each(['touchstart', 'slight reversal', 'touch pointer', 'pen pointer'] as const)('requires current gesture direction on positive scroll delivery (%s)', async (input) => {
    const geometry: Geometry = { top: 600, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })
    wheel(probe.scroller, -1)
    geometry.top = 598
    probe.scroller.dispatchEvent(new Event('scroll'))
    if (input === 'touch pointer' || input === 'pen pointer') {
      probe.scroller.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: input === 'touch pointer' ? 'touch' : 'pen' }))
    } else {
      wheel(probe.scroller, 1)
      touch(probe.scroller, 'touchstart', 100)
      if (input === 'slight reversal') {
        touch(probe.scroller, 'touchmove', 90)
        touch(probe.scroller, 'touchmove', 91)
      }
    }
    geometry.top = 599
    probe.scroller.dispatchEvent(new Event('scroll'))
    geometry.height = 960
    await probe.render({ revision: 1 })
    expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 599, writes: 0 })
  })

  test.each([
    ['layout', 'touch'], ['observer', 'touch'],
    ['layout', 'scrollbar'], ['observer', 'scrollbar'],
    ['layout', 'DOM'], ['observer', 'DOM'],
  ] as const)('preserves a single 1px pending upward move before %s growth (%s)', async (source, input) => {
    const geometry: Geometry = { top: 600, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })
    if (input === 'touch') {
      touch(probe.scroller, 'touchstart', 100)
      touch(probe.scroller, 'touchmove', 101)
    } else if (input === 'scrollbar') {
      probe.scroller.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    }
    geometry.top = 599
    geometry.height = 960
    if (source === 'layout') await probe.render({ revision: 1 })
    else TestResizeObserver.emit(probe.content)
    expect.soft({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 599, writes: 0 })
    probe.scroller.dispatchEvent(new Event('scroll'))
    geometry.height = 980
    await probe.render({ revision: 2 })
    TestResizeObserver.emit(probe.content)
    expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 599, writes: 0 })
  })

  test.each(['layout', 'observer'] as const)(
    'preserves a slight upward scroll when %s growth precedes native scroll delivery',
    async (growthSource) => {
      const geometry: Geometry = { top: 600, height: 900, client: 300, writes: 0 }
      const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })
      expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 600, writes: 0 })

      touch(probe.scroller, 'touchstart', 100)
      for (let step = 1; step <= 3; step += 1) {
        touch(probe.scroller, 'touchmove', 100 + step)
        // Model browser-owned movement through the backing geometry; the setter counts Hook writes.
        geometry.top -= 1
      }
      expect({ top: probe.scroller.scrollTop, writes: geometry.writes }).toEqual({ top: 597, writes: 0 })

      // Keep scroll delivery pending until the competing growth path has run.
      geometry.height = 960
      if (growthSource === 'layout') await probe.render({ revision: 1 })
      else TestResizeObserver.emit(probe.content)
      expect.soft({ top: geometry.top, writes: geometry.writes }, 'before native scroll delivery')
        .toEqual({ top: 597, writes: 0 })

      probe.scroller.dispatchEvent(new Event('scroll'))
      expect.soft({ top: geometry.top, writes: geometry.writes }, 'after delayed scroll delivery')
        .toEqual({ top: 597, writes: 0 })
    },
  )

  test('releases cumulative 1px upward touch intent before any DOM scroll movement', async () => {
    const geometry: Geometry = { top: 600, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })

    touch(probe.scroller, 'touchstart', 100)
    for (let step = 1; step <= 3; step += 1) {
      touch(probe.scroller, 'touchmove', 100 + step)
    }
    expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 600, writes: 0 })

    // Growth exposes release through observable writes while native movement is still pending.
    geometry.height = 960
    TestResizeObserver.emit(probe.content)
    expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 600, writes: 0 })
  })

  test('pins the initial view and writes only when growth creates bottom distance', async () => {
    const geometry: Geometry = { top: 0, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })

    expect(geometry.top).toBe(600)
    expect(geometry.writes).toBe(1)

    geometry.writes = 0
    await probe.render({ revision: 1 })
    await probe.render({ revision: 2 })
    expect(geometry.top).toBe(600)
    expect(geometry.writes).toBe(0)

    geometry.height = 960
    await probe.render({ revision: 3 })
    expect(geometry.top).toBe(660)
    expect(geometry.writes).toBe(1)
  })

  test.each(['horizontal', 'reversal', 'nested'] as const)('keeps follow through %s small touch samples', async (input) => {
    const geometry: Geometry = { top: 600, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })
    const target = input === 'nested' ? probe.nested : probe.scroller
    if (input === 'nested') Object.defineProperties(target, {
      clientHeight: { value: 100 }, scrollHeight: { value: 500 }, scrollTop: { value: 30, writable: true },
    })
    touch(target, 'touchstart', 100)
    if (input === 'reversal') {
      for (const y of [101, 102, 101, 102, 103]) touch(target, 'touchmove', y)
    } else {
      for (let step = 1; step <= 4; step += 1) touch(target, 'touchmove', 100 + step, input === 'horizontal' ? 20 + step * 4 : 20)
    }
    geometry.height = 960
    await probe.render({ revision: 1 })
    expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 660, writes: 1 })
    if (input === 'nested') {
      target.scrollTop = 0
      touch(target, 'touchmove', 105)
      geometry.height = 980
      TestResizeObserver.emit(probe.content)
      expect(geometry.top).toBe(680)
      for (const y of [106, 107]) touch(target, 'touchmove', y)
      geometry.writes = 0
      geometry.height = 1000
      TestResizeObserver.emit(probe.content)
      expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 680, writes: 0 })
    }
  })

  test('resumes through cumulative downward samples after a direction reversal', async () => {
    const geometry: Geometry = { top: 600, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })
    touch(probe.scroller, 'touchstart', 100)
    for (const y of [101, 102, 103]) touch(probe.scroller, 'touchmove', y)
    geometry.top = 500
    probe.scroller.dispatchEvent(new Event('scroll'))
    for (const y of [102, 101, 100]) touch(probe.scroller, 'touchmove', y)
    touch(probe.scroller, 'touchend')
    geometry.top = 600
    probe.scroller.dispatchEvent(new Event('scroll'))
    geometry.height = 960
    TestResizeObserver.emit(probe.content)
    expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 660, writes: 1 })
  })

  test.each(['shrink', 'viewport'] as const)('keeps follow after browser clamp from %s with early and late scroll delivery', async (change) => {
    const geometry: Geometry = { top: 600, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })
    for (const early of [true, false]) {
      if (change === 'shrink') geometry.height -= 60
      else geometry.client += 60
      geometry.top = geometry.height - geometry.client
      if (early) probe.scroller.dispatchEvent(new Event('scroll'))
      TestResizeObserver.emit(probe.content)
      await probe.render({ revision: early ? 1 : 3 })
      if (!early) probe.scroller.dispatchEvent(new Event('scroll'))
      expect(geometry.writes).toBe(0)
      geometry.height += 80
      await probe.render({ revision: early ? 2 : 4 })
      expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: geometry.height - geometry.client, writes: 1 })
      geometry.writes = 0
    }
  })

  test('checks pending movement even on a no-op frame and resets on a replacement node', async () => {
    const geometry: Geometry = { top: 600, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })
    geometry.top = 599
    await probe.render({ revision: 1 })
    geometry.height = 960
    TestResizeObserver.emit(probe.content)
    expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 599, writes: 0 })
    await probe.render({ nodeKey: 'replacement' })
    expect({ top: geometry.top, writes: geometry.writes }).toEqual({ top: 660, writes: 1 })
  })

  test('preserves a released reading position through stream bursts and programmatic bottom moves', async () => {
    const geometry: Geometry = { top: 0, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })

    wheel(probe.scroller, -80)
    geometry.top = 120
    probe.scroller.dispatchEvent(new Event('scroll'))
    geometry.writes = 0
    for (let revision = 1; revision <= 25; revision += 1) {
      geometry.height += 4
      await probe.render({ revision })
    }
    expect(geometry.top).toBe(120)
    expect(geometry.writes).toBe(0)

    geometry.top = geometry.height - geometry.client
    probe.scroller.dispatchEvent(new Event('scroll'))
    geometry.writes = 0
    geometry.height += 80
    await probe.render({ revision: 26 })
    TestResizeObserver.emit(probe.content)
    expect(geometry.top).toBe(700)
    expect(geometry.writes).toBe(0)
  })

  test('resumes follow after downward touch and inertia reach the true bottom', async () => {
    const geometry: Geometry = { top: 0, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })

    touch(probe.scroller, 'touchstart', 100)
    touch(probe.scroller, 'touchmove', 140)
    geometry.top = 140
    probe.scroller.dispatchEvent(new Event('scroll'))

    touch(probe.scroller, 'touchstart', 200)
    touch(probe.scroller, 'touchmove', 150)
    touch(probe.scroller, 'touchend')
    geometry.top = 600
    probe.scroller.dispatchEvent(new Event('scroll'))
    geometry.writes = 0

    geometry.height = 980
    await probe.render({ revision: 1 })
    expect(geometry.top).toBe(680)
    expect(geometry.writes).toBe(1)
  })

  test('lets a nested scroll region consume its upward gesture', async () => {
    const geometry: Geometry = { top: 0, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })
    Object.defineProperties(probe.nested, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 30 },
    })

    wheel(probe.nested, -40)
    geometry.writes = 0
    geometry.height = 940
    await probe.render({ revision: 1 })
    expect(geometry.top).toBe(640)
    expect(geometry.writes).toBe(1)

    probe.nested.scrollTop = 0
    wheel(probe.nested, -40)
    geometry.writes = 0
    geometry.height = 980
    await probe.render({ revision: 2 })
    expect(geometry.top).toBe(640)
    expect(geometry.writes).toBe(0)
  })

  test('follows asynchronous content resize and skips repeated no-op observer frames', async () => {
    const geometry: Geometry = { top: 0, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: true, assistantID: 'a', revision: 0, geometry })

    geometry.writes = 0
    geometry.height = 1020
    TestResizeObserver.emit(probe.content)
    expect(geometry.top).toBe(720)
    expect(geometry.writes).toBe(1)

    geometry.writes = 0
    TestResizeObserver.emit(probe.content)
    TestResizeObserver.emit(probe.content)
    expect(geometry.writes).toBe(0)
  })

  test('resets to latest on each active Assistant switch and stays inert while inactive', async () => {
    const geometry: Geometry = { top: 80, height: 900, client: 300, writes: 0 }
    const probe = await mountProbe({ active: false, assistantID: 'a', revision: 0, geometry })

    expect(geometry.top).toBe(80)
    expect(geometry.writes).toBe(0)
    expect(TestResizeObserver.instances.every((observer) => observer.observed.size === 0)).toBe(true)

    await probe.render({ assistantID: 'b', revision: 1 })
    expect(geometry.writes).toBe(0)
    await probe.render({ active: true })
    expect(geometry.top).toBe(600)
    expect(geometry.writes).toBe(1)

    wheel(probe.scroller, -40)
    geometry.top = 100
    probe.scroller.dispatchEvent(new Event('scroll'))
    geometry.writes = 0
    await probe.render({ assistantID: 'a', revision: 2 })
    expect(geometry.top).toBe(600)
    expect(geometry.writes).toBe(1)

    wheel(probe.scroller, -40)
    geometry.top = 160
    probe.scroller.dispatchEvent(new Event('scroll'))
    geometry.writes = 0
    await probe.render({ assistantID: 'b', revision: 3 })
    expect(geometry.top).toBe(600)
    expect(geometry.writes).toBe(1)

    await probe.render({ active: false })
    geometry.writes = 0
    geometry.height = 1100
    await probe.render({ assistantID: 'a', revision: 4 })
    TestResizeObserver.emit(probe.content)
    wheel(probe.scroller, -40)
    probe.scroller.dispatchEvent(new Event('scroll'))
    expect(geometry.top).toBe(600)
    expect(geometry.writes).toBe(0)
    expect(TestResizeObserver.instances.every((observer) => observer.observed.size === 0)).toBe(true)
  })
})
