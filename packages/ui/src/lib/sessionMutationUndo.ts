import React from "react"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import { UndoCountdownRing } from "@/components/ui/UndoCountdownRing"
import { useUIStore } from "@/stores/useUIStore"
import {
  SESSION_DELETE_UNDO_MS,
  cancelScheduledSessionDeletes,
  scheduleSessionDeletes,
  unarchiveSession,
} from "@/sync/session-actions"

export { SESSION_DELETE_UNDO_MS }

type ArchiveUndoToastArgs = {
  sessionIds: string[]
  message: string
  undoLabel: string
  settingsLabel: string
  undoFailedMessage: string
}

type DeleteUndoToastArgs = {
  sessionIds: string[]
  message: string
  undoLabel: string
  commitFailedMessage: string
  delayMs?: number
}

function openArchivedSessionsManager(): void {
  useUIStore.getState().setArchivedSessionsDialogOpen(true)
}

function showSessionUndoToast(args: {
  durationMs: number
  message: string
  primaryLabel: string
  onPrimary: () => void
  secondaryLabel?: string
  onSecondary?: () => void
}): void {
  toast.custom(
    (id) => React.createElement(
      "div",
      {
        className:
          "flex w-full min-w-0 max-w-full items-center gap-2.5 text-foreground",
      },
      React.createElement(
        "span",
        { className: "min-w-0 flex-1 truncate text-left typography-ui-label font-medium" },
        args.message,
      ),
      React.createElement(
        "div",
        { className: "flex shrink-0 items-center gap-1.5" },
        args.secondaryLabel && args.onSecondary
          ? React.createElement(
              Button,
              {
                variant: "secondary",
                size: "sm",
                className: "session-mutation-undo-action overflow-hidden !h-[26px] !min-h-0 !min-w-0 shrink-0 !px-2 !text-[12px]",
                onClick: () => {
                  args.onSecondary?.()
                  toast.dismiss(id)
                },
              },
              args.secondaryLabel,
            )
          : null,
        React.createElement(
          Button,
          {
            variant: "default",
            size: "sm",
            className: "session-mutation-undo-action overflow-hidden !h-[26px] !min-h-0 !min-w-0 shrink-0 gap-1 !pl-2 !pr-1 !text-[12px]",
            onClick: () => {
              args.onPrimary()
              toast.dismiss(id)
            },
          },
          args.primaryLabel,
          React.createElement(UndoCountdownRing, { durationMs: args.durationMs }),
        ),
      ),
    ),
    {
      duration: args.durationMs,
      className: "session-mutation-undo-toast !max-w-[calc(100vw-2rem)]",
    },
  )
}

/**
 * After a successful archive, show a short undo window and a shortcut into the
 * archived-sessions manager dialog. Do not expand the sidebar archived bucket.
 */
export function showArchivedSessionsUndoToast(args: ArchiveUndoToastArgs): void {
  const sessionIds = Array.from(new Set(args.sessionIds.filter(Boolean)))
  if (sessionIds.length === 0) return

  showSessionUndoToast({
    durationMs: SESSION_DELETE_UNDO_MS,
    message: args.message,
    primaryLabel: args.undoLabel,
    onPrimary: () => {
      void (async () => {
        const results = await Promise.all(sessionIds.map((id) => unarchiveSession(id)))
        if (results.some((ok) => !ok)) {
          toast.error(args.undoFailedMessage)
        }
      })()
    },
    secondaryLabel: args.settingsLabel,
    onSecondary: () => {
      openArchivedSessionsManager()
    },
  })
}

/**
 * Optimistically remove sessions and permanently delete after the undo window.
 * Undo cancels the server delete and restores local state.
 */
export function deleteSessionsWithUndo(args: DeleteUndoToastArgs): {
  batchId: string
  scheduledIds: string[]
} {
  const sessionIds = Array.from(new Set(args.sessionIds.filter(Boolean)))
  if (sessionIds.length === 0) {
    return { batchId: "", scheduledIds: [] }
  }

  const durationMs = args.delayMs ?? SESSION_DELETE_UNDO_MS
  const { batchId, scheduledIds } = scheduleSessionDeletes(sessionIds, {
    delayMs: durationMs,
    onSettled: ({ failedIds }) => {
      if (failedIds.length > 0) {
        toast.error(args.commitFailedMessage)
      }
    },
  })

  if (!batchId) {
    return { batchId, scheduledIds }
  }

  showSessionUndoToast({
    durationMs,
    message: args.message,
    primaryLabel: args.undoLabel,
    onPrimary: () => {
      cancelScheduledSessionDeletes(batchId)
    },
  })

  return { batchId, scheduledIds }
}
