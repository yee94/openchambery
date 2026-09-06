import { create } from 'zustand'
import { useAllSessionStatuses } from '@/sync/sync-context'

type AssistantContactWorkingState = {
  workingByID: Record<string, boolean>
  setWorking: (assistantID: string, working: boolean) => void
}

export const useAssistantContactWorkingStore = create<AssistantContactWorkingState>((set) => ({
  workingByID: {},
  setWorking: (assistantID, working) => set((state) => ({
    workingByID: { ...state.workingByID, [assistantID]: working },
  })),
}))

const sessionInFlight = (type: string | undefined) => type === 'busy' || type === 'retry'

export const isAssistantWorking = ({
  sending = false,
  processing = false,
  serverWorking = false,
  assignedSessionIDs = [],
  statuses = {},
}: {
  sending?: boolean
  processing?: boolean
  serverWorking?: boolean
  assignedSessionIDs?: string[]
  statuses?: Record<string, { type?: string } | undefined>
}) => {
  if (sending || processing || serverWorking) return true
  return assignedSessionIDs.some((sessionID) => sessionInFlight(statuses[sessionID]?.type))
}

export const useAssistantWorking = (
  assistantID: string,
  assignedSessionIDs: string[] = [],
  serverWorking = false,
) => {
  const contactWorking = useAssistantContactWorkingStore((state) => Boolean(state.workingByID[assistantID]))
  const statuses = useAllSessionStatuses()
  return isAssistantWorking({ processing: contactWorking, serverWorking, assignedSessionIDs, statuses })
}
