import { AssistantAPIError, type AssistantDTO, type AssistantDraft } from '@/queries/assistantQueries';
import { AssistantSelectionStaleError, type AssistantSelection, type AssistantSelectionIdentity } from './assistantSelectionCoordinator';

type AssistantSnapshot = { assistants: AssistantDTO[] };

type AssistantSelectionBackendDependencies = {
  readSnapshot: () => AssistantSnapshot | undefined;
  ensureSnapshot: (signal: AbortSignal) => Promise<AssistantSnapshot>;
  updateAssistant: (assistant: AssistantDTO, draft: AssistantDraft) => Promise<AssistantDTO>;
  assertAuthoritative: () => void;
  signal: AbortSignal;
};

const selectionDraft = (current: AssistantDTO, desired: AssistantSelection): AssistantDraft => {
  const providerID = desired.providerID ?? current.providerID;
  const modelID = desired.modelID ?? current.modelID;
  const modelChanged = providerID !== current.providerID || modelID !== current.modelID;
  return { enabled: current.enabled, name: current.name, defaultPrompt: current.defaultPrompt, workspacePath: current.workspacePath, providerID, modelID, agent: desired.agent ?? null, variant: modelChanged ? null : desired.variant ?? null, mode: current.mode };
};

export const commitAssistantSelection = async (identity: AssistantSelectionIdentity, desired: AssistantSelection, dependencies: AssistantSelectionBackendDependencies): Promise<void> => {
  dependencies.assertAuthoritative();
  let latest = dependencies.readSnapshot()?.assistants.find((item) => item.id === identity.assistantID);
  if (!latest) throw new Error('assistant_unavailable');
  try {
    dependencies.assertAuthoritative();
    await dependencies.updateAssistant(latest, selectionDraft(latest, desired));
    dependencies.assertAuthoritative();
  } catch (error) {
    dependencies.assertAuthoritative();
    if (dependencies.signal.aborted) throw new AssistantSelectionStaleError();
    if (!(error instanceof AssistantAPIError) || error.code !== 'revision_conflict') throw error;
    dependencies.assertAuthoritative();
    latest = (await dependencies.ensureSnapshot(dependencies.signal)).assistants.find((item) => item.id === identity.assistantID);
    dependencies.assertAuthoritative();
    if (!latest) throw new AssistantAPIError('revision_conflict', 409);
    dependencies.assertAuthoritative();
    await dependencies.updateAssistant(latest, selectionDraft(latest, desired));
    dependencies.assertAuthoritative();
  }
};
