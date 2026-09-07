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

export const isAssistantWorking = ({
  sending = false,
  processing = false,
}: {
  sending?: boolean
  processing?: boolean
}) => sending || processing

export const useAssistantWorking = (assistantID: string) => {
  const contactWorking = useAssistantContactWorkingStore((state) => Boolean(state.workingByID[assistantID]))
  return isAssistantWorking({ processing: contactWorking })
}
