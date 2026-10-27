import { animate, cubicBezier } from 'motion/react'

/**
 * Send transition ported from Telegram-iOS `ChatMessageTransitionNode` (text
 * input → bubble, default bezier parameters), itself a reproduction of iMessage:
 * the composer field's background frame morphs into the bubble frame,
 * bottom-anchored, with horizontal and vertical edges on separate curves; the
 * single outer background changes color into the bubble fill while the typed text
 * travels into the bubble and cross-fades into the rendered text.
 */
export const CONTACT_SEND_FLIGHT_DURATION_S = 0.3
export const CONTACT_SEND_FLIGHT_VERTICAL_EASE = [0.19919472913616398, 0.010644531250000006, 0.27920937042459737, 0.91025390625] as const
const HORIZONTAL_EASE = [0.23, 1, 0.32, 1] as const
const verticalCurve = cubicBezier(...CONTACT_SEND_FLIGHT_VERTICAL_EASE)
const horizontalCurve = cubicBezier(...HORIZONTAL_EASE)
const BACKGROUND_COLOR_DURATION_S = 0.15
const SOURCE_TEXT_FADE_S = 0.1
const TARGET_TEXT_FADE_S = 0.08

type Box = { left: number; top: number; width: number; height: number }
type Radii = [string, string, string, string]

/** Composer geometry and paint, captured synchronously before the draft clears. */
export type ContactSendFlightSource = {
  compact?: boolean
  background: Box
  backgroundColor: string
  radii: Radii
  text: string
  textBox: Box
  textStyle: Partial<CSSStyleDeclaration>
}

const box = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
const px = (value: string) => Number.parseFloat(value) || 0
const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress
const readRadii = (style: CSSStyleDeclaration): Radii => [
  style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius,
]
const contentBox = (element: HTMLElement): Box => {
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)
  const left = rect.left + px(style.borderLeftWidth) + px(style.paddingLeft)
  const top = rect.top + px(style.borderTopWidth) + px(style.paddingTop)
  return {
    left,
    top,
    width: rect.right - px(style.borderRightWidth) - px(style.paddingRight) - left,
    height: rect.bottom - px(style.borderBottomWidth) - px(style.paddingBottom) - top,
  }
}
const textStyleOf = (style: CSSStyleDeclaration): Partial<CSSStyleDeclaration> => ({
  color: style.color,
  fontFamily: style.fontFamily,
  fontSize: style.fontSize,
  fontWeight: style.fontWeight,
  fontFeatureSettings: style.fontFeatureSettings,
  letterSpacing: style.letterSpacing,
  lineHeight: style.lineHeight,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
})

export const captureContactSendFlightSource = (
  surface: HTMLElement,
  field: HTMLTextAreaElement,
  compact = false,
): ContactSendFlightSource | null => {
  if (!field.value.trim()) return null
  const surfaceStyle = window.getComputedStyle(surface)
  const textBox = contentBox(field)
  // Reference-highlighting composers paint text through an overlay and keep the field transparent.
  const painted = field.parentElement?.querySelector<HTMLElement>('[data-composer-highlight]')
  const textStyle = textStyleOf(window.getComputedStyle(field))
  if (painted) textStyle.color = window.getComputedStyle(painted).color
  return {
    compact,
    background: box(surface.getBoundingClientRect()),
    backgroundColor: surfaceStyle.backgroundColor,
    radii: readRadii(surfaceStyle),
    text: field.value,
    // The field's own scroll offset (Telegram `scrollOffset`) shifts its visible text up.
    textBox: { ...textBox, top: textBox.top - field.scrollTop },
    textStyle,
  }
}

const layer = (style: Partial<CSSStyleDeclaration>): HTMLDivElement => {
  const node = document.createElement('div')
  Object.assign(node.style, { position: 'absolute', pointerEvents: 'none', margin: '0px', ...style })
  return node
}

const fade = (node: HTMLElement, from: number, to: number, duration: number) => {
  node.style.opacity = String(from)
  return animate(node, { opacity: [from, to] }, { duration, ease: 'linear' })
}

/**
 * Starts the morph from the captured composer into `bubble`. The real bubble
 * keeps its layout and is only hidden while the overlay paints it, so the
 * transcript scroll owner stays authoritative; the bubble rectangle is re-read
 * every frame and the overlay lands wherever that scroll moved it. Returns an
 * idempotent stop that removes the overlay and reveals the bubble.
 */
export const startContactSendFlight = (
  source: ContactSendFlightSource,
  bubble: HTMLElement,
  hidden: HTMLElement = bubble,
  onSettled?: () => void,
): (() => void) => {
  const bubbleStyle = window.getComputedStyle(bubble)
  const targetRadii = readRadii(bubbleStyle)
  const initialTarget = box(bubble.getBoundingClientRect())
  const initialText = contentBox(bubble)
  const background = source.compact ? {
    ...source.background,
    left: source.textBox.left - px(bubbleStyle.paddingLeft),
    width: Math.min(source.background.width, Math.max(120, initialTarget.width + 32)),
  } : source.background
  // Telegram's source frame: the bubble's size, bottom-left aligned to the field background.
  const sourceOrigin = {
    left: background.left,
    top: background.top + background.height - initialTarget.height,
  }
  const textOffset = {
    x: (source.textBox.left - sourceOrigin.left) - (initialText.left - initialTarget.left),
    y: (source.textBox.top - sourceOrigin.top) - (initialText.top - initialTarget.top),
  }

  const clip = layer({ position: 'fixed', left: '0px', top: '0px', overflow: 'hidden', zIndex: '60', willChange: 'transform, width, height' })
  clip.setAttribute('aria-hidden', 'true')
  clip.setAttribute('data-assistant-contact-send-flight', '')
  clip.style.backgroundColor = source.backgroundColor
  const sourceText = layer({ ...source.textStyle, left: '0px', top: '0px', width: `${source.textBox.width}px` })
  sourceText.textContent = source.text
  const targetText = layer({ ...textStyleOf(bubbleStyle), left: '0px', top: '0px', width: `${initialText.width}px` })
  targetText.textContent = bubble.textContent ?? ''
  clip.append(sourceText, targetText)

  const place = (elapsed: number) => {
    const v = verticalCurve(elapsed)
    const h = horizontalCurve(elapsed)
    const target = box(bubble.getBoundingClientRect())
    const s = background
    const left = lerp(s.left, target.left, h)
    const right = lerp(s.left + s.width, target.left + target.width, h)
    const bottom = lerp(s.top + s.height, target.top + target.height, v)
    const height = lerp(s.height, target.height, v)
    const top = bottom - height
    clip.style.transform = `translate3d(${left}px, ${top}px, 0)`
    clip.style.width = `${right - left}px`
    clip.style.height = `${height}px`
    clip.style.borderRadius = targetRadii.map((radius, index) => (
      `${lerp(px(source.radii[index]), px(radius), v)}px`
    )).join(' ')
    // The text node sits inside the moving bubble container and travels from the
    // field's text origin to its own on the vertical curve (both axes).
    const containerLeft = target.left + (sourceOrigin.left - initialTarget.left) * (1 - h)
    const containerTop = target.top + (sourceOrigin.top - initialTarget.top) * (1 - v)
    const textLeft = containerLeft + (initialText.left - initialTarget.left) + textOffset.x * (1 - v) - left
    const textTop = containerTop + (initialText.top - initialTarget.top) + textOffset.y * (1 - v) - top
    const translate = `translate3d(${textLeft}px, ${textTop}px, 0)`
    sourceText.style.transform = translate
    targetText.style.transform = translate
  }

  let stopped = false
  const running: Array<{ stop: () => void }> = []
  const stop = () => {
    if (stopped) return
    stopped = true
    running.forEach((controls) => controls.stop())
    clip.remove()
    hidden.style.visibility = ''
    onSettled?.()
  }

  hidden.style.visibility = 'hidden'
  place(0)
  document.body.appendChild(clip)
  running.push(
    animate(clip, { backgroundColor: [source.backgroundColor, bubbleStyle.backgroundColor] }, {
      duration: BACKGROUND_COLOR_DURATION_S,
      ease: 'linear',
    }),
    fade(sourceText, 1, 0, SOURCE_TEXT_FADE_S),
    fade(targetText, 0, 1, TARGET_TEXT_FADE_S),
    animate(0, 1, {
      duration: CONTACT_SEND_FLIGHT_DURATION_S,
      ease: 'linear',
      onUpdate: place,
      onComplete: stop,
    }),
  )
  return stop
}
