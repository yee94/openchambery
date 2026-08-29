export type AssistantNestedOpenMode = 'context-panel' | 'session';

export const resolveAssistantNestedOpenMode = (input: {
  isPhoneShell: boolean;
  isMobile: boolean;
  isIPad: boolean;
  isVSCode: boolean;
}): AssistantNestedOpenMode => {
  if (input.isVSCode) return 'session';
  if (input.isPhoneShell || (input.isMobile && !input.isIPad)) return 'session';
  return 'context-panel';
};
