import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

import { useAssistantContactAutoFollow } from './useAssistantContactAutoFollow'

type HarnessState = {
  active: boolean
  assistantID: string
  revision: number
  height: number
}

type HarnessMeasure = {
  top: number
  scrollHeight: number
  clientHeight: number
  maxTop: number
  writes: number
}

type HarnessAPI = {
  patch: (patch: Partial<HarnessState>) => Promise<HarnessMeasure>
  releaseAt: (top: number) => HarnessMeasure
  programBottom: () => HarnessMeasure
  resumeAtBottomWithTouch: () => HarnessMeasure
  resetWrites: () => void
  measure: () => HarnessMeasure
}

declare global {
  interface Window {
    assistantContactAutoFollowHarness?: HarnessAPI
  }
}

let updateState: ((patch: Partial<HarnessState>) => void) | null = null
let writes = 0

const findScrollTopDescriptor = (element: HTMLElement): PropertyDescriptor => {
  let prototype: object | null = element
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollTop')
    if (descriptor?.get && descriptor.set) return descriptor
    prototype = Object.getPrototypeOf(prototype)
  }
  throw new Error('native scrollTop descriptor missing')
}

// eslint-disable-next-line react-refresh/only-export-components -- production-linked Chrome fixture mounts this component directly.
const App: React.FC = () => {
  const [state, setState] = React.useState<HarnessState>({
    active: true,
    assistantID: 'assistant-a',
    revision: 0,
    height: 800,
  })
  updateState = (patch) => setState((current) => ({ ...current, ...patch }))
  const { scrollRef, contentRef } = useAssistantContactAutoFollow({
    active: state.active,
    assistantID: state.assistantID,
    contentRevision: state.revision,
  })
  const attachScroller = React.useMemo<React.RefCallback<HTMLDivElement>>(() => (node) => {
    if (node && !Object.prototype.hasOwnProperty.call(node, 'scrollTop')) {
      const native = findScrollTopDescriptor(node)
      Object.defineProperty(node, 'scrollTop', {
        configurable: true,
        get: () => native.get?.call(node),
        set: (value: number) => {
          writes += 1
          native.set?.call(node, value)
        },
      })
    }
    scrollRef(node)
  }, [scrollRef])

  return (
    <div
      ref={attachScroller}
      data-test-scroller=""
      style={{ height: 200, width: 320, overflowY: 'auto' }}
    >
      <div ref={contentRef} data-test-content="" style={{ height: state.height, width: 300 }} />
    </div>
  )
}

const rootNode = document.getElementById('root')
if (!rootNode) throw new Error('fixture root missing')
flushSync(() => createRoot(rootNode).render(<App />))

const scroller = document.querySelector<HTMLElement>('[data-test-scroller]')
if (!scroller) throw new Error('fixture scroller missing')

const measure = (): HarnessMeasure => ({
  top: scroller.scrollTop,
  scrollHeight: scroller.scrollHeight,
  clientHeight: scroller.clientHeight,
  maxTop: scroller.scrollHeight - scroller.clientHeight,
  writes,
})

const settle = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

const patch = async (next: Partial<HarnessState>) => {
  if (!updateState) throw new Error('fixture state unavailable')
  flushSync(() => updateState?.(next))
  await settle()
  return measure()
}

const dispatchTouch = (type: string, clientY?: number) => {
  const touch = clientY === undefined ? null : new Touch({
    identifier: 1,
    target: scroller,
    clientX: 20,
    clientY,
    pageX: 20,
    pageY: clientY,
    screenX: 20,
    screenY: clientY,
  })
  scroller.dispatchEvent(new TouchEvent(type, {
    bubbles: true,
    touches: touch ? [touch] : [],
    targetTouches: touch ? [touch] : [],
    changedTouches: touch ? [touch] : [],
  }))
}

window.assistantContactAutoFollowHarness = {
  patch,
  releaseAt: (top) => {
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -60 }))
    scroller.scrollTop = top
    scroller.dispatchEvent(new Event('scroll'))
    writes = 0
    return measure()
  },
  programBottom: () => {
    scroller.scrollTop = scroller.scrollHeight
    scroller.dispatchEvent(new Event('scroll'))
    writes = 0
    return measure()
  },
  resumeAtBottomWithTouch: () => {
    dispatchTouch('touchstart', 180)
    dispatchTouch('touchmove', 120)
    scroller.scrollTop = scroller.scrollHeight
    scroller.dispatchEvent(new Event('scroll'))
    dispatchTouch('touchend')
    writes = 0
    return measure()
  },
  resetWrites: () => { writes = 0 },
  measure,
}

export {}
