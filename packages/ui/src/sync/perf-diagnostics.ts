/**
 * Lightweight performance probes for client diagnostics (`feat: "perf"`).
 *
 * Always-on observers stay cheap; window aggregates are written only while the
 * shared About diagnostics switch is on. Probe callbacks never throw into the
 * caller path.
 */

import { getClientPlatform } from "@/lib/platform"

import type { TranscriptDiagnosticsEvent } from "./transcript-diagnostics"
import {
  isTranscriptDiagnosticsEnabled,
  recordTranscriptDiagnostics,
} from "./transcript-diagnostics-runtime"

export const PERF_DIAGNOSTICS_WINDOW_MS = 30_000
export const PERF_DIAGNOSTICS_FPS_SAMPLE_MS = 3_000
/** Internal lag probe cadence (not part of the public window contract). */
const PERF_DIAGNOSTICS_LAG_INTERVAL_MS = 1_000

export type PerfHapticStrength = "light" | "medium" | "heavy"

export type FpsStats = {
  readonly avg: number | null
  readonly min: number | null
  readonly p10: number | null
}

export type PerfWindowSnapshot = {
  readonly fpsAvg?: number
  readonly fpsMin?: number
  readonly fpsP10?: number
  readonly longTaskCount: number
  readonly longTaskTotalMs: number
  readonly longTaskMaxMs: number
  readonly eventLoopLagMaxMs: number
  readonly eventLoopLagAvgMs: number
  readonly hapticLightCount: number
  readonly hapticMediumCount: number
  readonly hapticHeavyCount: number
}

type PerfMemory = {
  usedJSHeapSize?: number
  jsHeapSizeLimit?: number
}

let hapticLightCount = 0
let hapticMediumCount = 0
let hapticHeavyCount = 0

let activeStop: (() => void) | null = null

export function notePerfHapticFired(strength: PerfHapticStrength): void {
  try {
    if (strength === "medium") {
      hapticMediumCount += 1
      return
    }
    if (strength === "heavy") {
      hapticHeavyCount += 1
      return
    }
    hapticLightCount += 1
  } catch {
    // Diagnostics must never affect the haptic call path.
  }
}

/** Test/helper: current module haptic counters (does not reset). */
export function getPerfHapticCounts(): {
  light: number
  medium: number
  heavy: number
} {
  return {
    light: hapticLightCount,
    medium: hapticMediumCount,
    heavy: hapticHeavyCount,
  }
}

/** Test/helper: zero module haptic counters. */
export function resetPerfHapticCounts(): void {
  hapticLightCount = 0
  hapticMediumCount = 0
  hapticHeavyCount = 0
}

export function computeFpsStats(deltasMs: number[]): FpsStats {
  if (deltasMs.length === 0) {
    return { avg: null, min: null, p10: null }
  }

  const fpsValues = deltasMs.map((delta) => (delta > 0 ? 1000 / delta : 0))
  const sum = fpsValues.reduce((acc, value) => acc + value, 0)
  const avg = sum / fpsValues.length
  const min = Math.min(...fpsValues)
  const sorted = [...fpsValues].sort((a, b) => a - b)
  const p10Index = Math.max(0, Math.min(sorted.length - 1, Math.floor(0.1 * (sorted.length - 1))))
  const p10 = sorted[p10Index] ?? min

  return { avg, min, p10 }
}

export function createPerfWindowAggregator() {
  let longTaskCount = 0
  let longTaskTotalMs = 0
  let longTaskMaxMs = 0
  let lagCount = 0
  let lagTotalMs = 0
  let lagMaxMs = 0
  let hapticLight = 0
  let hapticMedium = 0
  let hapticHeavy = 0
  const fpsDeltasMs: number[] = []

  return {
    addLongTaskMs(durationMs: number): void {
      if (!Number.isFinite(durationMs) || durationMs < 0) return
      longTaskCount += 1
      longTaskTotalMs += durationMs
      if (durationMs > longTaskMaxMs) longTaskMaxMs = durationMs
    },
    addLagMs(lagMs: number): void {
      if (!Number.isFinite(lagMs) || lagMs < 0) return
      lagCount += 1
      lagTotalMs += lagMs
      if (lagMs > lagMaxMs) lagMaxMs = lagMs
    },
    addFpsDelta(deltaMs: number): void {
      if (!Number.isFinite(deltaMs) || deltaMs < 0) return
      fpsDeltasMs.push(deltaMs)
    },
    noteHaptic(strength: PerfHapticStrength): void {
      if (strength === "medium") {
        hapticMedium += 1
        return
      }
      if (strength === "heavy") {
        hapticHeavy += 1
        return
      }
      hapticLight += 1
    },
    snapshotWindow(): PerfWindowSnapshot {
      const fps = computeFpsStats(fpsDeltasMs)
      const snapshot: PerfWindowSnapshot = {
        longTaskCount,
        longTaskTotalMs,
        longTaskMaxMs,
        eventLoopLagMaxMs: lagMaxMs,
        eventLoopLagAvgMs: lagCount > 0 ? lagTotalMs / lagCount : 0,
        hapticLightCount: hapticLight,
        hapticMediumCount: hapticMedium,
        hapticHeavyCount: hapticHeavy,
      }
      if (fps.avg != null) {
        return {
          ...snapshot,
          fpsAvg: fps.avg,
          fpsMin: fps.min ?? undefined,
          fpsP10: fps.p10 ?? undefined,
        }
      }
      return snapshot
    },
    reset(): void {
      longTaskCount = 0
      longTaskTotalMs = 0
      longTaskMaxMs = 0
      lagCount = 0
      lagTotalMs = 0
      lagMaxMs = 0
      hapticLight = 0
      hapticMedium = 0
      hapticHeavy = 0
      fpsDeltasMs.length = 0
    },
  }
}

type PerfWindowAggregator = ReturnType<typeof createPerfWindowAggregator>

export type PerfDiagnosticsControllerDeps = {
  isEnabled?: () => boolean
  record?: (event: TranscriptDiagnosticsEvent) => void
  now?: () => number
  getPlatform?: () => string
}

function readJsHeapMb(): { used?: number; limit?: number } {
  try {
    const memory = (performance as Performance & { memory?: PerfMemory }).memory
    if (!memory) return {}
    const used = typeof memory.usedJSHeapSize === "number"
      ? Math.round(memory.usedJSHeapSize / (1024 * 1024))
      : undefined
    const limit = typeof memory.jsHeapSizeLimit === "number"
      ? Math.round(memory.jsHeapSizeLimit / (1024 * 1024))
      : undefined
    return { used, limit }
  } catch {
    return {}
  }
}

function readVisibilityFlags(): { visible?: boolean; foreground?: boolean } {
  const flags: { visible?: boolean; foreground?: boolean } = {}
  try {
    if (typeof document !== "undefined" && document.visibilityState) {
      flags.visible = document.visibilityState === "visible"
    }
  } catch {
    // omit
  }
  try {
    if (typeof document !== "undefined" && document.documentElement) {
      flags.foreground = document.documentElement.classList.contains("oc-native-app-active")
    }
  } catch {
    // omit when DOM is unavailable
  }
  return flags
}

function buildPerfWindowEvent(input: {
  at: number
  snapshot: PerfWindowSnapshot
  haptics: { light: number; medium: number; heavy: number }
  platform: string
}): TranscriptDiagnosticsEvent {
  const heap = readJsHeapMb()
  const visibility = readVisibilityFlags()
  const event: TranscriptDiagnosticsEvent = {
    at: input.at,
    feat: "perf",
    kind: "perf-window",
    sessionID: "app",
    longTaskCount: input.snapshot.longTaskCount,
    longTaskTotalMs: input.snapshot.longTaskTotalMs,
    longTaskMaxMs: input.snapshot.longTaskMaxMs,
    eventLoopLagMaxMs: input.snapshot.eventLoopLagMaxMs,
    eventLoopLagAvgMs: input.snapshot.eventLoopLagAvgMs,
    hapticLightCount: input.haptics.light,
    hapticMediumCount: input.haptics.medium,
    hapticHeavyCount: input.haptics.heavy,
    platform: input.platform,
  }

  const withOptional: TranscriptDiagnosticsEvent = {
    ...event,
    ...(input.snapshot.fpsAvg != null ? {
      fpsAvg: input.snapshot.fpsAvg,
      fpsMin: input.snapshot.fpsMin,
      fpsP10: input.snapshot.fpsP10,
    } : {}),
    ...(heap.used != null ? { jsHeapUsedMB: heap.used } : {}),
    ...(heap.limit != null ? { jsHeapLimitMB: heap.limit } : {}),
    ...(visibility.visible != null ? { visible: visibility.visible } : {}),
    ...(visibility.foreground != null ? { foreground: visibility.foreground } : {}),
  }

  return withOptional
}

/**
 * Idempotent start. Returns a stop function that clears timers/observers.
 * A second start while running returns the existing stop (no double install).
 */
export function startPerfDiagnosticsController(
  deps: PerfDiagnosticsControllerDeps = {},
): () => void {
  if (activeStop) return activeStop

  const isEnabled = deps.isEnabled ?? isTranscriptDiagnosticsEnabled
  const record = deps.record ?? recordTranscriptDiagnostics
  const now = deps.now ?? (() => Date.now())
  const getPlatform = deps.getPlatform ?? (() => getClientPlatform())

  const aggregator = createPerfWindowAggregator()
  let stopped = false
  let windowTimer: ReturnType<typeof setTimeout> | undefined
  let lagTimer: ReturnType<typeof setTimeout> | undefined
  let fpsSampleTimer: ReturnType<typeof setTimeout> | undefined
  let fpsRafId: number | undefined
  let lastFpsTs: number | undefined
  let longTaskObserver: PerformanceObserver | undefined
  let longTaskUnsupported = false

  const safe = (fn: () => void): void => {
    try {
      fn()
    } catch {
      // Probe callbacks must never escape.
    }
  }

  const stopFpsSample = (): void => {
    if (fpsSampleTimer != null) {
      clearTimeout(fpsSampleTimer)
      fpsSampleTimer = undefined
    }
    if (fpsRafId != null && typeof cancelAnimationFrame === "function") {
      try {
        cancelAnimationFrame(fpsRafId)
      } catch {
        // ignore
      }
      fpsRafId = undefined
    }
    lastFpsTs = undefined
  }

  const startFpsSample = (): void => {
    stopFpsSample()
    if (typeof requestAnimationFrame !== "function") return

    const sampleUntil = now() + PERF_DIAGNOSTICS_FPS_SAMPLE_MS
    const tick = (ts: number): void => {
      if (stopped) return
      safe(() => {
        if (lastFpsTs != null) {
          aggregator.addFpsDelta(ts - lastFpsTs)
        }
        lastFpsTs = ts
        if (now() < sampleUntil) {
          fpsRafId = requestAnimationFrame(tick)
        } else {
          fpsRafId = undefined
          lastFpsTs = undefined
        }
      })
    }

    fpsRafId = requestAnimationFrame(tick)
    fpsSampleTimer = setTimeout(() => {
      safe(() => {
        if (fpsRafId != null && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(fpsRafId)
          fpsRafId = undefined
        }
        lastFpsTs = undefined
      })
    }, PERF_DIAGNOSTICS_FPS_SAMPLE_MS)
  }

  const flushWindow = (): void => {
    safe(() => {
      const snapshot = aggregator.snapshotWindow()
      const haptics = getPerfHapticCounts()
      if (isEnabled()) {
        record(buildPerfWindowEvent({
          at: now(),
          snapshot,
          haptics,
          platform: getPlatform(),
        }))
      }
      // Always clear window-scoped counters; do not write when disabled.
      resetPerfHapticCounts()
      aggregator.reset()
    })
  }

  const scheduleWindow = (): void => {
    windowTimer = setTimeout(() => {
      if (stopped) return
      flushWindow()
      startFpsSample()
      scheduleWindow()
    }, PERF_DIAGNOSTICS_WINDOW_MS)
  }

  const scheduleLagProbe = (): void => {
    const expected = now() + PERF_DIAGNOSTICS_LAG_INTERVAL_MS
    lagTimer = setTimeout(() => {
      if (stopped) return
      safe(() => {
        const lagMs = Math.max(0, now() - expected)
        aggregator.addLagMs(lagMs)
      })
      scheduleLagProbe()
    }, PERF_DIAGNOSTICS_LAG_INTERVAL_MS)
  }

  safe(() => {
    if (typeof PerformanceObserver === "undefined") {
      longTaskUnsupported = true
      return
    }
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        safe(() => {
          for (const entry of list.getEntries()) {
            aggregator.addLongTaskMs(entry.duration)
          }
        })
      })
      longTaskObserver.observe({ entryTypes: ["longtask"] })
    } catch {
      longTaskUnsupported = true
      longTaskObserver = undefined
    }
  })

  void longTaskUnsupported

  startFpsSample()
  scheduleLagProbe()
  scheduleWindow()

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (windowTimer != null) clearTimeout(windowTimer)
    if (lagTimer != null) clearTimeout(lagTimer)
    stopFpsSample()
    if (longTaskObserver) {
      try {
        longTaskObserver.disconnect()
      } catch {
        // ignore
      }
      longTaskObserver = undefined
    }
    if (activeStop === stop) activeStop = null
  }

  activeStop = stop
  return stop
}
