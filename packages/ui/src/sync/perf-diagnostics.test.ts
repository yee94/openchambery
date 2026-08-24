import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const { recordMock, isEnabledMock } = vi.hoisted(() => ({
  recordMock: vi.fn(),
  isEnabledMock: vi.fn(() => true),
}))

vi.mock("./transcript-diagnostics-runtime", () => ({
  isTranscriptDiagnosticsEnabled: () => isEnabledMock(),
  recordTranscriptDiagnostics: (event: unknown) => recordMock(event),
}))

vi.mock("@/lib/platform", () => ({
  getClientPlatform: () => "android",
}))

import {
  PERF_DIAGNOSTICS_FPS_SAMPLE_MS,
  PERF_DIAGNOSTICS_WINDOW_MS,
  computeFpsStats,
  createPerfWindowAggregator,
  getPerfHapticCounts,
  notePerfHapticFired,
  resetPerfHapticCounts,
  startPerfDiagnosticsController,
} from "./perf-diagnostics"

describe("perf diagnostics constants", () => {
  test("exports the 30s window and 3s FPS duty cycle", () => {
    expect(PERF_DIAGNOSTICS_WINDOW_MS).toBe(30_000)
    expect(PERF_DIAGNOSTICS_FPS_SAMPLE_MS).toBe(3_000)
  })
})

describe("perf diagnostics aggregator", () => {
  test("aggregates longtask, lag, and haptic stats and resets cleanly", () => {
    const agg = createPerfWindowAggregator()
    agg.addLongTaskMs(50)
    agg.addLongTaskMs(120)
    agg.addLagMs(10)
    agg.addLagMs(30)
    agg.noteHaptic("light")
    agg.noteHaptic("medium")
    agg.noteHaptic("heavy")
    agg.noteHaptic("light")

    const snap = agg.snapshotWindow()
    expect(snap.longTaskCount).toBe(2)
    expect(snap.longTaskTotalMs).toBe(170)
    expect(snap.longTaskMaxMs).toBe(120)
    expect(snap.eventLoopLagMaxMs).toBe(30)
    expect(snap.eventLoopLagAvgMs).toBe(20)
    expect(snap.hapticLightCount).toBe(2)
    expect(snap.hapticMediumCount).toBe(1)
    expect(snap.hapticHeavyCount).toBe(1)
    expect(snap.fpsAvg).toBeUndefined()

    agg.reset()
    const empty = agg.snapshotWindow()
    expect(empty.longTaskCount).toBe(0)
    expect(empty.longTaskTotalMs).toBe(0)
    expect(empty.longTaskMaxMs).toBe(0)
    expect(empty.eventLoopLagMaxMs).toBe(0)
    expect(empty.eventLoopLagAvgMs).toBe(0)
    expect(empty.hapticLightCount).toBe(0)
    expect(empty.hapticMediumCount).toBe(0)
    expect(empty.hapticHeavyCount).toBe(0)
  })

  test("includes fps fields only when deltas exist", () => {
    const agg = createPerfWindowAggregator()
    agg.addFpsDelta(16.67)
    agg.addFpsDelta(20)
    const snap = agg.snapshotWindow()
    expect(snap.fpsAvg).toBeCloseTo((1000 / 16.67 + 1000 / 20) / 2, 5)
    expect(snap.fpsMin).toBeCloseTo(50, 5)
    expect(snap.fpsP10).toBeDefined()
  })
})

describe("computeFpsStats", () => {
  test("returns null fields for empty input", () => {
    expect(computeFpsStats([])).toEqual({ avg: null, min: null, p10: null })
  })

  test("computes avg/min/p10 for known frame intervals", () => {
    // 10 frames @ 100ms => 10 fps each
    const deltas = Array.from({ length: 10 }, () => 100)
    const stats = computeFpsStats(deltas)
    expect(stats.avg).toBe(10)
    expect(stats.min).toBe(10)
    expect(stats.p10).toBe(10)

    // Mixed: 50ms (20fps), 100ms (10fps), 200ms (5fps)
    const mixed = computeFpsStats([50, 100, 200])
    expect(mixed.avg).toBeCloseTo((20 + 10 + 5) / 3, 5)
    expect(mixed.min).toBe(5)
    // sorted fps: 5, 10, 20; p10 index floor(0.1*2)=0 => 5
    expect(mixed.p10).toBe(5)
  })
})

describe("notePerfHapticFired", () => {
  beforeEach(() => {
    resetPerfHapticCounts()
  })

  afterEach(() => {
    resetPerfHapticCounts()
  })

  test("accumulates haptic counters by strength", () => {
    notePerfHapticFired("light")
    notePerfHapticFired("light")
    notePerfHapticFired("medium")
    notePerfHapticFired("heavy")
    expect(getPerfHapticCounts()).toEqual({ light: 2, medium: 1, heavy: 1 })
  })

  test("never throws on unexpected strength paths", () => {
    expect(() => notePerfHapticFired("light")).not.toThrow()
  })
})

describe("startPerfDiagnosticsController", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    recordMock.mockClear()
    isEnabledMock.mockReset()
    isEnabledMock.mockReturnValue(true)
    resetPerfHapticCounts()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetPerfHapticCounts()
  })

  test("writes a perf-window event after one window when enabled", () => {
    const stop = startPerfDiagnosticsController({
      isEnabled: () => isEnabledMock(),
      record: (event) => recordMock(event),
      now: () => Date.now(),
      getPlatform: () => "android",
    })

    notePerfHapticFired("medium")
    vi.advanceTimersByTime(PERF_DIAGNOSTICS_WINDOW_MS)

    expect(recordMock).toHaveBeenCalledTimes(1)
    const event = recordMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(event.feat).toBe("perf")
    expect(event.kind).toBe("perf-window")
    expect(event.sessionID).toBe("app")
    expect(event.platform).toBe("android")
    expect(event.hapticMediumCount).toBe(1)
    expect(event.hapticLightCount).toBe(0)

    stop()
  })

  test("does not write when diagnostics are disabled but still resets", () => {
    isEnabledMock.mockReturnValue(false)
    const stop = startPerfDiagnosticsController({
      isEnabled: () => isEnabledMock(),
      record: (event) => recordMock(event),
      now: () => Date.now(),
      getPlatform: () => "web",
    })

    notePerfHapticFired("heavy")
    vi.advanceTimersByTime(PERF_DIAGNOSTICS_WINDOW_MS)

    expect(recordMock).not.toHaveBeenCalled()
    expect(getPerfHapticCounts()).toEqual({ light: 0, medium: 0, heavy: 0 })

    stop()
  })

  test("start is idempotent and stop cleans up", () => {
    const stop1 = startPerfDiagnosticsController({
      isEnabled: () => true,
      record: (event) => recordMock(event),
      now: () => Date.now(),
    })
    const stop2 = startPerfDiagnosticsController({
      isEnabled: () => true,
      record: (event) => recordMock(event),
      now: () => Date.now(),
    })
    expect(stop2).toBe(stop1)

    stop1()
    vi.advanceTimersByTime(PERF_DIAGNOSTICS_WINDOW_MS)
    expect(recordMock).not.toHaveBeenCalled()

    // Can start again after stop
    const stop3 = startPerfDiagnosticsController({
      isEnabled: () => true,
      record: (event) => recordMock(event),
      now: () => Date.now(),
      getPlatform: () => "ios",
    })
    vi.advanceTimersByTime(PERF_DIAGNOSTICS_WINDOW_MS)
    expect(recordMock).toHaveBeenCalledTimes(1)
    stop3()
  })
})
