import { create } from 'zustand'

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

/**
 * List green-dot / contact busy. Server snapshot `working` is authoritative for
 * APP restart and reconnect. Local sending/processing is temporary continuity
 * until the snapshot/SSE catches up — never the sole durable source.
 */
export const isAssistantWorking = ({
  sending = false,
  processing = false,
  serverWorking = false,
}: {
  sending?: boolean
  processing?: boolean
  serverWorking?: boolean
}) => sending || processing || serverWorking

export const useAssistantWorking = (assistantID: string, serverWorking = false) => {
  const contactWorking = useAssistantContactWorkingStore((state) => Boolean(state.workingByID[assistantID]))
  return isAssistantWorking({ processing: contactWorking, serverWorking })
}
