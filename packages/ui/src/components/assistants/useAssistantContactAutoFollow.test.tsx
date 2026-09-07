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
}

const Probe: React.FC<ProbeProps> = ({ active, assistantID, revision, geometry }) => {
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
    <div ref={attachScroller} data-test-scroller="">
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

const touch = (target: Element, type: string, clientY?: number) => {
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, 'touches', {
    value: {
      item: (index: number) => index === 0 && clientY !== undefined ? { clientY } : null,
    },
  })
  target.dispatchEvent(event)
}

describe('useAssistantContactAutoFollow', () => {
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
