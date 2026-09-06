export type LynxAssistantMode = 'continuous' | 'stateless';

export type LynxAssistantDTO = {
  id: string;
  revision: number;
  enabled: boolean;
  name: string;
  defaultPrompt: string;
  workspacePath: string | null;
  effectiveWorkspacePath: string;
  managedWorkspacePath: string | null;
  providerID: string;
  modelID: string;
  agent: string | null;
  variant: string | null;
  mode: LynxAssistantMode;
  sessionID: string | null;
  sessionGeneration: number;
  historySessionIDs: string[];
  historySessionCount: number;
  createdAt: number | null;
  updatedAt: number;
  tombstoneAt: number | null;
};

export type LynxAssistantSnapshot = {
  revision: number;
  enabled: boolean;
  assistants: LynxAssistantDTO[];
};

export type LynxAssistantCapability = {
  supported: boolean;
  enabled: boolean;
  revision: number;
  serverInstanceID: string | null;
};

export type LynxAssistantLoadResult =
  | { status: 'ok'; snapshot: LynxAssistantSnapshot }
  | { status: 'unsupported' }
  | { status: 'failed'; error: Error }
  | { status: 'no-runtime' };
