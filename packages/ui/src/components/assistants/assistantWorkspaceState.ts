type AssistantWorkspacePresentation = 'loading' | 'unavailable' | 'onboarding' | 'ready';

export const resolveAssistantWorkspacePresentation = (input: {
  capabilityPending: boolean;
  snapshotPending: boolean;
  capabilityError: boolean;
  supported?: boolean;
  capabilityEnabled?: boolean;
  snapshotEnabled?: boolean;
  snapshotSettled: boolean;
  assistantCount: number;
  hasAssistant: boolean;
}): AssistantWorkspacePresentation => {
  if (input.capabilityPending) return 'loading';
  if (input.capabilityError || input.supported !== true || input.capabilityEnabled !== true) return 'unavailable';
  if (input.snapshotPending) return 'loading';
  if (input.snapshotEnabled !== true) return 'unavailable';
  if (input.assistantCount === 0) return 'onboarding';
  // /assistant/$id can select before the snapshot arrives. Missing assistant
  // is unavailable only after that snapshot has settled.
  if (!input.hasAssistant) return input.snapshotSettled ? 'unavailable' : 'loading';
  return 'ready';
};
