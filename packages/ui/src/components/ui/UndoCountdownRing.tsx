import React from "react"
import { cn } from "@/lib/utils"

type Props = {
  durationMs: number
  size?: number
  className?: string
}

/**
 * Circular countdown for undo toasts. The browser interpolates the ring while
 * React only updates the visible number as each second elapses.
 */
export function UndoCountdownRing({
  durationMs,
  size = 15,
  className,
}: Props): React.ReactNode {
  const strokeWidth = 1.5
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const [isRunning, setIsRunning] = React.useState(false)
  const [remainingSeconds, setRemainingSeconds] = React.useState(() =>
    Math.max(0, Math.ceil(durationMs / 1_000) - 1),
  )

  React.useEffect(() => {
    const start = performance.now()
    const frame = window.requestAnimationFrame(() => setIsRunning(true))
    const updateRemainingSeconds = () => {
      const elapsed = performance.now() - start
      setRemainingSeconds(Math.max(0, Math.ceil((durationMs - elapsed) / 1_000) - 1))
    }
    const interval = window.setInterval(updateRemainingSeconds, 250)

    return () => {
      window.cancelAnimationFrame(frame)
      window.clearInterval(interval)
    }
  }, [durationMs])

  return (
    <span
      className={cn("oc-undo-countdown", className)}
      style={{ ["--oc-undo-countdown-size" as string]: `${size}px` }}
      aria-hidden="true"
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        className="oc-undo-countdown-svg"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--interactive-border)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--primary-base)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={isRunning ? circumference : 0}
          style={{ transition: `stroke-dashoffset ${durationMs}ms linear` }}
        />
      </svg>
      <span className="oc-undo-countdown-digit text-current">
        {remainingSeconds}
      </span>
    </span>
  )
}
