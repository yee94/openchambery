import { create } from 'zustand'
import { useAllSessionStatuses } from '@/sync/sync-context'

type AssistantContactWorkingState = {
  sendingByID: Record<string, boolean>
  setSending: (assistantID: string, sending: boolean) => void
}

export const useAssistantContactWorkingStore = create<AssistantContactWorkingState>((set) => ({
  sendingByID: {},
  setSending: (assistantID, sending) => set((state) => ({
    sendingByID: { ...state.sendingByID, [assistantID]: sending },
  })),
}))

const sessionInFlight = (type: string | undefined) => type === 'busy' || type === 'retry'

export const isAssistantWorking = ({
  sending = false,
  serverWorking = false,
  assignedSessionIDs = [],
  statuses = {},
}: {
  sending?: boolean
  serverWorking?: boolean
  assignedSessionIDs?: string[]
  statuses?: Record<string, { type?: string } | undefined>
}) => {
  if (sending || serverWorking) return true
  return assignedSessionIDs.some((sessionID) => sessionInFlight(statuses[sessionID]?.type))
}

export const useAssistantWorking = (
  assistantID: string,
  assignedSessionIDs: string[] = [],
  serverWorking = false,
) => {
  const sending = useAssistantContactWorkingStore((state) => Boolean(state.sendingByID[assistantID]))
  const statuses = useAllSessionStatuses()
  return isAssistantWorking({ sending, serverWorking, assignedSessionIDs, statuses })
}
