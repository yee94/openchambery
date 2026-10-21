import React from 'react'
import { animate, useReducedMotion } from 'motion/react'
import { useEvent, useEventListener, useResizeObserver } from '@reactuses/core'
import {
  isReleaseKey,
  nestedScrollableCanConsumeUp,
  TOUCH_FINGER_DOWN_THRESHOLD,
} from '@/hooks/lib/chatUpwardIntent'

const BOTTOM_TOLERANCE_PX = 2
const USER_SCROLL_INTENT_TTL_MS = 1500

type ScrollGeometry = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

type ScrollDirection = 'up' | 'down' | 'scrollbar'

type UseAssistantContactAutoFollowOptions = {
  active: boolean
  assistantID: string
  contentRevision: string | number
  onLoadEarlier?: () => void
}

type UseAssistantContactAutoFollowResult = {
  scrollRef: React.RefCallback<HTMLDivElement>
  contentRef: React.RefCallback<HTMLDivElement>
  preparePrepend: () => void
}

const readScrollGeometry = (element: HTMLElement): ScrollGeometry => ({
  scrollTop: element.scrollTop,
  scrollHeight: element.scrollHeight,
  clientHeight: element.clientHeight,
})

const distanceFromBottom = (geometry: ScrollGeometry): number => (
  geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight
)

const isAtBottom = (geometry: ScrollGeometry): boolean => (
  distanceFromBottom(geometry) <= BOTTOM_TOLERANCE_PX
)

const nestedScrollableCanConsumeDown = (root: HTMLElement, target: EventTarget | null): boolean => {
  let node: Element | null = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null
  while (node && node !== root) {
    if (
      node instanceof HTMLElement
      && node.scrollHeight > node.clientHeight + 1
      && node.scrollTop + node.clientHeight < node.scrollHeight - 1
    ) {
      return true
    }
    node = node.parentElement
  }
  return false
}

const isResumeKey = (event: KeyboardEvent): boolean => {
  if (event.altKey || event.ctrlKey || event.metaKey) return false
  return event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End'
}

/**
 * Owns the compact contact transcript's bottom-follow policy. Contact keeps one
 * direct scroll writer while user gestures and the browser retain native scroll.
 */
export const useAssistantContactAutoFollow = ({
  active,
  assistantID,
  contentRevision,
  onLoadEarlier,
}: UseAssistantContactAutoFollowOptions): UseAssistantContactAutoFollowResult => {
  const scrollNodeRef = React.useRef<HTMLDivElement | null>(null)
  const [scrollNode, setScrollNode] = React.useState<HTMLDivElement | null>(null)
  const [contentNode, setContentNode] = React.useState<HTMLDivElement | null>(null)
  const followingRef = React.useRef(true)
  const anchorRef = React.useRef<{ id: string; offset: number; scrollTop: number } | null>(null)
  const activeIdentityRef = React.useRef<string | null>(null)
  const baselineNodeRef = React.useRef<HTMLDivElement | null>(null)
  const lastScrollTopRef = React.useRef(0)
  const touchRef = React.useRef<{ x: number; y: number; deltaX: number; deltaY: number } | null>(null)
  const userIntentRef = React.useRef<{ direction: ScrollDirection; expiresAt: number } | null>(null)
  const activeRef = React.useRef(active)
  activeRef.current = active
  const reducedMotion = useReducedMotion()
  const initialPositionedRef = React.useRef(false)
  const followAnimationRef = React.useRef<{ stop: () => void } | null>(null)
  const followTargetRef = React.useRef<number | null>(null)
  const stopFollowAnimation = useEvent(() => {
    followAnimationRef.current?.stop()
    followAnimationRef.current = null
    followTargetRef.current = null
  })

  const scrollRef = React.useMemo<React.RefCallback<HTMLDivElement>>(() => (node) => {
    scrollNodeRef.current = node
    setScrollNode((current) => current === node ? current : node)
  }, [])

  const contentRef = React.useMemo<React.RefCallback<HTMLDivElement>>(() => (node) => {
    setContentNode((current) => current === node ? current : node)
  }, [])

  const captureAnchor = useEvent(() => {
    const root = scrollNodeRef.current
    if (!root || !activeRef.current || followingRef.current) return
    const top = root.getBoundingClientRect().top
    const row = Array.from(root.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find((node) => node.getBoundingClientRect().bottom > top)
    anchorRef.current = row ? { id: row.dataset.messageId!, offset: row.getBoundingClientRect().top - top, scrollTop: root.scrollTop } : null
  })
  const restoreAnchor = useEvent(() => {
    const root = scrollNodeRef.current
    const anchor = anchorRef.current
    if (!root || !activeRef.current || followingRef.current) return
    if (!anchor) { captureAnchor(); return }
    // Native gestures can move the DOM before their scroll event reaches React.
    const scrolled = root.scrollTop - anchor.scrollTop
    // A held finger owns the position: a write here would cancel the pan.
    if (Math.abs(scrolled) > 0.5 && touchRef.current) {
      lastScrollTopRef.current = root.scrollTop
      captureAnchor()
      return
    }
    const row = Array.from(root.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find((node) => node.dataset.messageId === anchor.id)
    if (!row) { captureAnchor(); return }
    // Wheel/scrollbar input already applied by the compositor moves the anchor
    // by exactly `scrolled`; only growth beyond that is compensated.
    const delta = row.getBoundingClientRect().top - root.getBoundingClientRect().top - (anchor.offset - scrolled)
    if (Math.abs(delta) > 0.5) root.scrollTop += delta
    lastScrollTopRef.current = root.scrollTop
    anchorRef.current = { id: anchor.id, offset: row.getBoundingClientRect().top - root.getBoundingClientRect().top, scrollTop: root.scrollTop }
  })
  const preparePrepend = useEvent(() => {
    stopFollowAnimation()
    followingRef.current = false
    lastScrollTopRef.current = scrollNodeRef.current?.scrollTop ?? 0
    captureAnchor()
  })

  const pinToBottom = useEvent(() => {
    if (!activeRef.current || !followingRef.current) return false
    const element = scrollNodeRef.current
    if (!element) return false
    const geometry = readScrollGeometry(element)
    // A shrinking scroll range can clamp the browser to its new maximum.
    const previousTop = Math.min(lastScrollTopRef.current, Math.max(0, geometry.scrollHeight - geometry.clientHeight))
    if (geometry.scrollTop < previousTop - 0.5) {
      stopFollowAnimation()
      followingRef.current = false
      lastScrollTopRef.current = geometry.scrollTop
      captureAnchor()
      return false
    }
    const initial = !initialPositionedRef.current
    if (initial && element.querySelector('[data-message-id]')) initialPositionedRef.current = true
    if (isAtBottom(geometry)) {
      stopFollowAnimation()
      lastScrollTopRef.current = geometry.scrollTop
      return false
    }
    const target = Math.max(0, geometry.scrollHeight - geometry.clientHeight)
    if (!initial && !reducedMotion) {
      if (followTargetRef.current === target) return false
      stopFollowAnimation()
      followTargetRef.current = target
      followAnimationRef.current = animate(element.scrollTop, target, {
        duration: 0.22,
        ease: 'easeOut',
        onUpdate: (top) => {
          if (!activeRef.current || !followingRef.current || scrollNodeRef.current !== element) return
          const maximum = Math.max(0, element.scrollHeight - element.clientHeight)
          if (element.scrollTop < Math.min(lastScrollTopRef.current, maximum) - 0.5) {
            followingRef.current = false
            stopFollowAnimation()
            lastScrollTopRef.current = element.scrollTop
            captureAnchor()
            return
          }
          element.scrollTop = Math.min(Math.max(element.scrollTop, top), maximum)
          lastScrollTopRef.current = element.scrollTop
        },
        onComplete: () => {
          followAnimationRef.current = null
          followTargetRef.current = null
        },
      })
      return true
    }
    stopFollowAnimation()
    element.scrollTop = target
    lastScrollTopRef.current = element.scrollTop
    return true
  })

  const rememberUserIntent = useEvent((direction: ScrollDirection) => {
    userIntentRef.current = {
      direction,
      expiresAt: performance.now() + USER_SCROLL_INTENT_TTL_MS,
    }
  })

  const currentUserIntent = useEvent((): ScrollDirection | null => {
    const intent = userIntentRef.current
    if (!intent) return null
    if (performance.now() > intent.expiresAt) {
      userIntentRef.current = null
      return null
    }
    return intent.direction
  })

  const releaseFollow = useEvent(() => {
    stopFollowAnimation()
    followingRef.current = false
    captureAnchor()
  })

  const handleScroll = useEvent(() => {
    if (!activeRef.current) return
    const element = scrollNodeRef.current
    if (!element) return
    const geometry = readScrollGeometry(element)
    const movedDown = geometry.scrollTop > lastScrollTopRef.current
    const previousTop = Math.min(lastScrollTopRef.current, Math.max(0, geometry.scrollHeight - geometry.clientHeight))
    lastScrollTopRef.current = geometry.scrollTop

    if (followingRef.current) {
      if (geometry.scrollTop < previousTop - 0.5) releaseFollow()
      return
    }

    const intent = currentUserIntent()
    // Re-capturing here would adopt any same-frame growth above the reader
    // (image/Markdown hydration during momentum) as the new baseline before the
    // resize observer can compensate it. restoreAnchor compensates, then re-captures.
    restoreAnchor()
    if (geometry.scrollTop <= 80 && intent === 'up') onLoadEarlier?.()
    if (movedDown && isAtBottom(geometry) && (intent === 'down' || intent === 'scrollbar')) {
      followingRef.current = true
    }
  })

  const handleWheel = useEvent((event: WheelEvent) => {
    const element = scrollNodeRef.current
    if (!element || event.deltaY === 0) return
    if (event.deltaY < 0) {
      if (nestedScrollableCanConsumeUp(element, event.target)) return
      rememberUserIntent('up')
      releaseFollow()
      if (element.scrollTop <= 80) onLoadEarlier?.()
      return
    }
    if (nestedScrollableCanConsumeDown(element, event.target)) return
    rememberUserIntent('down')
  })

  const handleTouchStart = useEvent((event: TouchEvent) => {
    userIntentRef.current = null
    const touch = event.touches.item(0)
    touchRef.current = touch ? { x: touch.clientX, y: touch.clientY, deltaX: 0, deltaY: 0 } : null
  })

  const handleTouchMove = useEvent((event: TouchEvent) => {
    const element = scrollNodeRef.current
    const touch = event.touches.item(0)
    if (!element || !touch) {
      touchRef.current = null
      return
    }
    const previous = touchRef.current
    if (!previous) return
    const stepY = touch.clientY - previous.y
    const reversed = stepY * previous.deltaY < 0
    const deltaX = (reversed ? 0 : previous.deltaX) + touch.clientX - previous.x
    const fingerDelta = (reversed ? 0 : previous.deltaY) + stepY
    touchRef.current = { x: touch.clientX, y: touch.clientY, deltaX, deltaY: fingerDelta }
    if (Math.abs(deltaX) >= Math.abs(fingerDelta)) return
    if (fingerDelta > 0 && nestedScrollableCanConsumeUp(element, event.target)
      || fingerDelta < 0 && nestedScrollableCanConsumeDown(element, event.target)) {
      touchRef.current.deltaX = 0
      touchRef.current.deltaY = 0
      return
    }
    rememberUserIntent(fingerDelta > 0 ? 'up' : 'down')
    if (fingerDelta > TOUCH_FINGER_DOWN_THRESHOLD) {
      releaseFollow()
      if (element.scrollTop <= 80) onLoadEarlier?.()
    }
  })

  const handleTouchEnd = useEvent(() => {
    touchRef.current = null
  })

  const handleKeyDown = useEvent((event: KeyboardEvent) => {
    if (isReleaseKey(event)) {
      rememberUserIntent('up')
      releaseFollow()
      if ((scrollNodeRef.current?.scrollTop ?? Infinity) <= 80) onLoadEarlier?.()
      return
    }
    if (isResumeKey(event)) rememberUserIntent('down')
  })

  const handlePointerDown = useEvent((event: PointerEvent) => {
    const element = scrollNodeRef.current
    if (event.pointerType !== 'mouse' || event.target !== element) return
    rememberUserIntent('scrollbar')
  })

  React.useLayoutEffect(() => {
    const identity = active ? assistantID : null
    const element = scrollNodeRef.current
    if (activeIdentityRef.current !== identity || baselineNodeRef.current !== element) {
      stopFollowAnimation()
      initialPositionedRef.current = false
      activeIdentityRef.current = identity
      baselineNodeRef.current = element
      followingRef.current = true
      anchorRef.current = null
      userIntentRef.current = null
      touchRef.current = null
      lastScrollTopRef.current = element?.scrollTop ?? 0
    }
    if (!active) return
    pinToBottom()
    restoreAnchor()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- these values own rerun semantics; useEvent keeps the writer current.
  }, [active, assistantID, contentRevision, scrollNode, reducedMotion])

  React.useLayoutEffect(() => () => { stopFollowAnimation() }, [active, assistantID, scrollNode, stopFollowAnimation])

  const noEventTarget = React.useMemo(() => () => undefined, [])
  const listenerTarget = active && scrollNode ? scrollNode : noEventTarget
  const passive = React.useMemo(() => ({ passive: true } as const), [])

  useEventListener('scroll', handleScroll, listenerTarget, passive)
  useEventListener('wheel', handleWheel, listenerTarget, passive)
  useEventListener('touchstart', handleTouchStart, listenerTarget, passive)
  useEventListener('touchmove', handleTouchMove, listenerTarget, passive)
  useEventListener('touchend', handleTouchEnd, listenerTarget, passive)
  useEventListener('touchcancel', handleTouchEnd, listenerTarget, passive)
  useEventListener('keydown', handleKeyDown, listenerTarget)
  useEventListener('pointerdown', handlePointerDown, listenerTarget, passive)

  const handleContentResize = useEvent(() => {
    pinToBottom()
    restoreAnchor()
  })
  const canObserveResize = typeof ResizeObserver !== 'undefined'
  useResizeObserver(canObserveResize && active ? contentNode : null, handleContentResize)

  return { scrollRef, contentRef, preparePrepend }
}
