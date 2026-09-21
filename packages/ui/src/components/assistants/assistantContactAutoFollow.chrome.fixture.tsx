import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

import { useAssistantContactAutoFollow } from './useAssistantContactAutoFollow'

type HarnessState = {
  active: boolean
  assistantID: string
  revision: number
  height: number
  earlier: number | null
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
  prependEvidence: () => Promise<{ before: number; afterPrepend: number; afterImage: number; messages: number }>
  slightTouchBeforeLayout: (input: 'touch' | 'scrollbar' | 'DOM' | 'cumulative' | 'late-scrollbar' | 'late-wheel' | 'late-touch-pointer' | 'late-previous-touch') => Promise<{
    beforeGrowth: HarnessMeasure
    afterGrowth: HarnessMeasure
    afterDelivery: HarnessMeasure
    afterLateGrowth: HarnessMeasure
    scrollEventsBeforeGrowth: number
    scrollEventsAfterGrowth: number
    scrollEventsAfterDelivery: number
  }>
}

declare global {
  interface Window {
    assistantContactAutoFollowHarness?: HarnessAPI
  }
}

let updateState: ((patch: Partial<HarnessState>) => void) | null = null
let writes = 0
let preparePrepend: (() => void) | null = null

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
    earlier: null,
  })
  updateState = (patch) => setState((current) => ({ ...current, ...patch }))
  const { scrollRef, contentRef, preparePrepend: prepare } = useAssistantContactAutoFollow({
    active: state.active,
    assistantID: state.assistantID,
    contentRevision: state.revision,
  })
  preparePrepend = prepare
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
      style={{ height: 200, width: 320, overflowY: 'auto', overflowAnchor: 'none' }}
    >
      <div ref={contentRef} data-test-content="" style={{ height: state.earlier === null ? state.height : undefined, width: 300 }}>
        {state.earlier === null ? null : Array.from({ length: 20 + state.earlier }, (_, index) => index - (state.earlier ?? 0)).map((id) =>
          <div key={id} data-message-id={`message-${id}`} style={{ minHeight: 72, padding: 8, boxSizing: 'border-box' }}>
            {id === -1 ? <img data-late-image="" alt="Synthetic attachment" style={{ display: 'block', maxWidth: '100%' }} /> : null}
            Synthetic message {id}
          </div>)}
      </div>
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
  prependEvidence: async () => {
    await patch({ earlier: 0, revision: 1 })
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 }))
    scroller.scrollTop = 20
    scroller.dispatchEvent(new Event('scroll'))
    const row = document.querySelector<HTMLElement>('[data-message-id="message-0"]')!
    const offset = () => row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    const before = offset()
    preparePrepend?.()
    await patch({ earlier: 20, revision: 2 })
    const afterPrepend = offset()
    const image = document.querySelector<HTMLImageElement>('[data-late-image]')!
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('synthetic image failed'))
      image.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="gray"/></svg>')}`
    })
    await settle()
    return { before, afterPrepend, afterImage: offset(), messages: document.querySelectorAll('[data-message-id]').length }
  },
  slightTouchBeforeLayout: async (input) => {
    await patch({ assistantID: 'delayed-scroll', revision: 0, height: 800 })
    let scrollEvents = 0
    const recordScroll = () => { scrollEvents += 1 }
    scroller.addEventListener('scroll', recordScroll)
    try {
      const lateGrowth = input.startsWith('late-')
      if (input === 'late-wheel') scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }))
      if (input === 'late-previous-touch') {
        dispatchTouch('touchstart', 200)
        dispatchTouch('touchmove', 190)
        dispatchTouch('touchend')
      }
      if (input === 'late-scrollbar' || input === 'late-touch-pointer') {
        scroller.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: input === 'late-scrollbar' ? 'mouse' : 'touch' }))
      }
      if (lateGrowth) {
        dispatchTouch('touchstart', 100)
        dispatchTouch('touchmove', 101)
      }
      if (input === 'touch' || input === 'cumulative') dispatchTouch('touchstart', 100)
      if (input === 'scrollbar') scroller.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
      for (let step = 1; step <= (input === 'cumulative' ? 3 : 1); step += 1) {
        if (input === 'touch' || input === 'cumulative') dispatchTouch('touchmove', 100 + step)
        // The native setter schedules browser scroll delivery for a later rendering step.
        if (input !== 'cumulative') scroller.scrollTop -= 1
      }
      // Exclude fixture-owned movement from the Hook write budget.
      writes = 0
      const beforeGrowth = measure()
      const scrollEventsBeforeGrowth = scrollEvents
      flushSync(() => updateState?.({ revision: 1, height: lateGrowth ? 800 : 860 }))
      const afterGrowth = measure()
      const scrollEventsAfterGrowth = scrollEvents
      await settle()
      const afterDelivery = measure()
      const scrollEventsAfterDelivery = scrollEvents
      if (lateGrowth) await patch({ revision: 2, height: 860 })
      return {
        beforeGrowth,
        afterGrowth,
        afterDelivery,
        afterLateGrowth: measure(),
        scrollEventsBeforeGrowth,
        scrollEventsAfterGrowth,
        scrollEventsAfterDelivery,
      }
    } finally {
      dispatchTouch('touchend')
      scroller.removeEventListener('scroll', recordScroll)
    }
  },
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
