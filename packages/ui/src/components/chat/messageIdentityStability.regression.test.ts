import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Regression contract for the sub-agent header identity flicker
 * (Trace: user report 2026-08-18/19 — assistant avatar/model badge flashed
 * back to the generic fallback on every runtime update).
 *
 * Runtime `message.updated` payloads carry agent/provider/model identity only
 * on a message's first publish. Every transcript write seam must therefore
 * preserve identity fields the incoming payload omits, and the header must
 * survive row remounts. This test pins the wiring; behavioral coverage lives
 * in the owning suites (event-reducer, materialization, diagnostics).
 */

const readSource = (relative: string): string =>
  readFileSync(join(__dirname, relative), "utf8")

describe("message identity stability contract", () => {
  test("SSE reducer merges message.updated with identity preservation", () => {
    const source = readSource("../../sync/transcript-event-reducer.ts")
    expect(source).toContain("MESSAGE_IDENTITY_FIELDS")
    expect(source).toContain("export function mergeTranscriptMessageUpdate")
    expect(source).toMatch(/case "message\.updated":[\s\S]*?mergeTranscriptMessageUpdate\(existing, info\)/)
  })

  test("HTTP upsert (recovery/reconcile) goes through the same identity merge", () => {
    const source = readSource("../../sync/materialization.ts")
    expect(source).toContain('import { mergeTranscriptMessageUpdate } from "./transcript-event-reducer"')
    expect(source).toMatch(/upsertMessages[\s\S]*?mergeTranscriptMessageUpdate\(live, snapshot\)/)
  })

  test("ChatMessage header falls back to last-known identity across remounts", () => {
    const source = readSource("./ChatMessage.tsx")
    expect(source).toContain("messageIdentitiesCache")
    expect(source).toContain("const stableAgentName = agentName ?? cachedMessageIdentity?.agent")
    expect(source).toContain("useStickyDisplayValue<string>(stableAgentName)")
  })

  test("pending send paints the assistant header before the first assistant row", () => {
    const source = readSource("./lib/pendingAssistantHeader.ts")
    expect(source).toContain("export const shouldShowPendingAssistantHeader")
    expect(source).toContain("readUserMessageHeaderIdentity")
    expect(source).toContain("resolvePendingAssistantHeader")
    const turnItem = readSource("./components/TurnItem.tsx")
    expect(turnItem).toContain("pendingAssistantHeader")
    expect(turnItem).toContain("<MessageHeader")
  })

  test("diagnostics expose identity-missing facts without values", () => {
    const source = readSource("../../sync/transcript-diagnostics.ts")
    expect(source).toContain("identityMissingCount")
    expect(source).toContain("identityLost")
    expect(source).toContain("snapshotMessageIdentityMissing")
  })
})
