import { describe, expect, test } from "bun:test"
import React from "react"
import { renderToString } from "react-dom/server"
import { UndoCountdownRing } from "@/components/ui/UndoCountdownRing"

describe("UndoCountdownRing", () => {
  test("renders a numbered circular countdown with semantic theme strokes", () => {
    const html = renderToString(<UndoCountdownRing durationMs={10_000} />)

    expect(html).toContain(">9</span>")
    expect(html).toContain("oc-undo-countdown-svg")
    expect(html).toContain("oc-undo-countdown-digit")
    expect(html).toContain("--oc-undo-countdown-size:15px")
    expect(html.match(/<circle/g)).toHaveLength(2)
    expect(html).toContain("var(--interactive-border)")
    expect(html).toContain("var(--primary-base)")
  })

  test("animates the progress ring over the supplied duration", () => {
    const html = renderToString(<UndoCountdownRing durationMs={7_500} />)

    expect(html).toContain("stroke-dashoffset 7500ms linear")
  })
})
