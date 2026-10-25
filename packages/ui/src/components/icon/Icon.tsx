import React from "react"
import { cn } from "@/lib/utils"
import { iconSpriteData } from "./sprite"
import type { IconName } from "./icons"

const SPRITE_ID = "yuri-icon-sprite-v2"

/** Codex/Lucide-style stroke weight (Lucide default is 2; thinner reads more refined). */
export const ICON_STROKE_WIDTH = 1.5

/** Slightly heavier stroke for small chrome (message actions) — clearer on dense/mobile screens without going solid. */
export const ICON_STROKE_WIDTH_MEDIUM = 2

const ICON_SPRITE_SIGNATURE = (() => {
  let hash = 2166136261
  for (const [name, content] of Object.entries(iconSpriteData)) {
    const value = `${name}:${content};`
    for (let index = 0; index < value.length; index += 1) {
      hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
    }
  }
  return (hash >>> 0).toString(36)
})()

let spriteInjected = false
let injectedIconNames = new Set<string>()
let injectedSpriteSignature: string | null = null

function ensureSpriteOnce(requiredName: IconName) {
  if (
    spriteInjected
    && injectedIconNames.has(requiredName)
    && injectedSpriteSignature === ICON_SPRITE_SIGNATURE
  ) return
  if (typeof document === "undefined") return
  const body = document.body
  if (!body) return

  const existing = document.getElementById(SPRITE_ID)
  if (existing) {
    // 旧 sprite 写死 stroke-width，换成 CSS var 后需重建才能让 weight 生效
    const existingIconNames = new Set(
      Array.from(existing.querySelectorAll('symbol[id^="yuri-"]'), (symbol) => symbol.id.slice(3)),
    )
    if (
      !existing.innerHTML.includes('--yuri-icon-stroke')
      || existing.dataset.spriteSignature !== ICON_SPRITE_SIGNATURE
      || !existingIconNames.has(requiredName)
    ) {
      existing.remove()
    } else {
      spriteInjected = true
      injectedIconNames = existingIconNames
      injectedSpriteSignature = ICON_SPRITE_SIGNATURE
      return
    }
  }

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.id = SPRITE_ID
  svg.setAttribute("aria-hidden", "true")
  svg.dataset.spriteSignature = ICON_SPRITE_SIGNATURE
  svg.style.display = "none"
  // Stroke weight via CSS var so individual <Icon> instances can bump weight
  // (e.g. message actions) without regenerating the sprite.
  svg.innerHTML = Object.entries(iconSpriteData)
    .map(
      ([name, content]) =>
        `<symbol id="yuri-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="var(--yuri-icon-stroke, ${ICON_STROKE_WIDTH})" stroke-linecap="round" stroke-linejoin="round">${content}</symbol>`
    )
    .join("")
  body.insertBefore(svg, body.firstChild)
  spriteInjected = true
  injectedIconNames = new Set(Object.keys(iconSpriteData))
  injectedSpriteSignature = ICON_SPRITE_SIGNATURE
}

export interface IconProps extends React.ComponentPropsWithoutRef<"svg"> {
  name: IconName
  /** `medium` ≈ Lucide default (2) — use for small action chrome that must stay legible on mobile. */
  weight?: "regular" | "medium"
}

export const Icon = React.memo(({ name, className, weight = "regular", style, ...rest }: IconProps) => {
  // Inline sprite injection during render – must run before <use> tries
  // to resolve the #yuri-* reference during the same commit.
  if (typeof document !== "undefined") {
    ensureSpriteOnce(name)
  }

  const strokeWidth = weight === "medium" ? ICON_STROKE_WIDTH_MEDIUM : ICON_STROKE_WIDTH

  return (
    <svg
      className={cn("yuri-icon", className)}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        // 让 <use> 克隆继承实例描边粗细（symbol 用 var(--yuri-icon-stroke)）
        ["--yuri-icon-stroke" as string]: strokeWidth,
        ...style,
      }}
      {...rest}
    >
      <use href={`#yuri-${name}`} />
    </svg>
  )
})

Icon.displayName = "Icon"
