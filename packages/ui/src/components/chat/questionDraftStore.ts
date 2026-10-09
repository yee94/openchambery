import { create } from 'zustand';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

interface QuestionDraft {
  activeTab: string;
  selectedOptions: Record<number, string[]>;
  customMode: Record<number, boolean>;
  customText: Record<number, string>;
  customTextFilled: Record<number, boolean>;
  interacted: boolean;
  pausePending: boolean;
  pauseFailed: boolean;
}

const EMPTY_DRAFT: QuestionDraft = {
  activeTab: '0', selectedOptions: {}, customMode: {}, customText: {}, customTextFilled: {}, interacted: false,
  pausePending: false, pauseFailed: false,
};

export const useQuestionDraftStore = create<{ drafts: Record<string, QuestionDraft> }>(() => ({ drafts: {} }));

export const selectQuestionDraft = (state: ReturnType<typeof useQuestionDraftStore.getState>, scope: string): QuestionDraft => state.drafts[scope] ?? EMPTY_DRAFT;
export const getQuestionDraft = (scope: string): QuestionDraft => selectQuestionDraft(useQuestionDraftStore.getState(), scope);

export function updateQuestionDraft(scope: string, update: (draft: QuestionDraft) => Partial<QuestionDraft>) {
  useQuestionDraftStore.setState((state) => {
    const current = state.drafts[scope] ?? EMPTY_DRAFT;
    const patch = update(current);
    if (Object.entries(patch).every(([key, value]) => current[key as keyof QuestionDraft] === value)) return state;
    return { drafts: { ...state.drafts, [scope]: { ...current, ...patch } } };
  });
}

export function discardQuestionDraft(scope: string) {
  useQuestionDraftStore.setState((state) => {
    if (!state.drafts[scope]) return state;
    const drafts = { ...state.drafts };
    delete drafts[scope];
    return { drafts };
  });
}

subscribeRuntimeEndpointChanged(() => useQuestionDraftStore.setState({ drafts: {} }));
