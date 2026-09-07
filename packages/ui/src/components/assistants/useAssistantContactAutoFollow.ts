import React from 'react'
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
}

type UseAssistantContactAutoFollowResult = {
  scrollRef: React.RefCallback<HTMLDivElement>
  contentRef: React.RefCallback<HTMLDivElement>
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
}: UseAssistantContactAutoFollowOptions): UseAssistantContactAutoFollowResult => {
  const scrollNodeRef = React.useRef<HTMLDivElement | null>(null)
  const [scrollNode, setScrollNode] = React.useState<HTMLDivElement | null>(null)
  const [contentNode, setContentNode] = React.useState<HTMLDivElement | null>(null)
  const followingRef = React.useRef(true)
  const activeIdentityRef = React.useRef<string | null>(null)
  const lastScrollTopRef = React.useRef(0)
  const touchLastYRef = React.useRef<number | null>(null)
  const userIntentRef = React.useRef<{ direction: ScrollDirection; expiresAt: number } | null>(null)
  const activeRef = React.useRef(active)
  activeRef.current = active

  const scrollRef = React.useMemo<React.RefCallback<HTMLDivElement>>(() => (node) => {
    scrollNodeRef.current = node
    setScrollNode((current) => current === node ? current : node)
  }, [])

  const contentRef = React.useMemo<React.RefCallback<HTMLDivElement>>(() => (node) => {
    setContentNode((current) => current === node ? current : node)
  }, [])

  const pinToBottom = useEvent(() => {
    if (!activeRef.current || !followingRef.current) return false
    const element = scrollNodeRef.current
    if (!element) return false
    const geometry = readScrollGeometry(element)
    if (isAtBottom(geometry)) {
      lastScrollTopRef.current = geometry.scrollTop
      return false
    }
    element.scrollTop = element.scrollHeight
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
    followingRef.current = false
  })

  const handleScroll = useEvent(() => {
    if (!activeRef.current) return
    const element = scrollNodeRef.current
    if (!element) return
    const geometry = readScrollGeometry(element)
    const previousTop = lastScrollTopRef.current
    lastScrollTopRef.current = geometry.scrollTop

    if (followingRef.current) {
      if (geometry.scrollTop < previousTop - 0.5) releaseFollow()
      return
    }

    const intent = currentUserIntent()
    if (isAtBottom(geometry) && (intent === 'down' || intent === 'scrollbar')) {
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
      return
    }
    if (nestedScrollableCanConsumeDown(element, event.target)) return
    rememberUserIntent('down')
  })

  const handleTouchStart = useEvent((event: TouchEvent) => {
    const touch = event.touches.item(0)
    touchLastYRef.current = touch ? touch.clientY : null
  })

  const handleTouchMove = useEvent((event: TouchEvent) => {
    const element = scrollNodeRef.current
    const touch = event.touches.item(0)
    if (!element || !touch) {
      touchLastYRef.current = null
      return
    }
    const previousY = touchLastYRef.current
    touchLastYRef.current = touch.clientY
    if (previousY === null) return
    const fingerDelta = touch.clientY - previousY
    if (fingerDelta > TOUCH_FINGER_DOWN_THRESHOLD) {
      if (nestedScrollableCanConsumeUp(element, event.target)) return
      rememberUserIntent('up')
      releaseFollow()
      return
    }
    if (fingerDelta < -TOUCH_FINGER_DOWN_THRESHOLD) {
      if (nestedScrollableCanConsumeDown(element, event.target)) return
      rememberUserIntent('down')
    }
  })

  const handleTouchEnd = useEvent(() => {
    touchLastYRef.current = null
  })

  const handleKeyDown = useEvent((event: KeyboardEvent) => {
    if (isReleaseKey(event)) {
      rememberUserIntent('up')
      releaseFollow()
      return
    }
    if (isResumeKey(event)) rememberUserIntent('down')
  })

  const handlePointerDown = useEvent((event: PointerEvent) => {
    const element = scrollNodeRef.current
    if (event.target !== element) return
    rememberUserIntent('scrollbar')
  })

  React.useLayoutEffect(() => {
    const identity = active ? assistantID : null
    if (activeIdentityRef.current !== identity) {
      activeIdentityRef.current = identity
      followingRef.current = true
      userIntentRef.current = null
      touchLastYRef.current = null
    }
    if (!active) return
    const element = scrollNodeRef.current
    lastScrollTopRef.current = element?.scrollTop ?? 0
    pinToBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- these values own rerun semantics; useEvent keeps the writer current.
  }, [active, assistantID, contentRevision, scrollNode])

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
  })
  const canObserveResize = typeof ResizeObserver !== 'undefined'
  useResizeObserver(canObserveResize && active ? contentNode : null, handleContentResize)

  return { scrollRef, contentRef }
}
