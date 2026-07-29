export type PermissionAction = 'allow' | 'ask' | 'deny';
export type PermissionRule = { permission: string; pattern: string; action: PermissionAction };
export type AgentMode = 'primary' | 'subagent' | 'all';
type AgentScope = 'user' | 'project';

export type AgentEditorSnapshot = {
  description: string;
  mode: AgentMode;
  model: string;
  variant: string;
  temperature: number | undefined;
  topP: number | undefined;
  prompt: string;
  globalPermission: PermissionAction;
  permissionRules: PermissionRule[];
};

type AgentSaveConfig = {
  name: string;
  description?: string;
  mode?: AgentMode;
  model?: string | null;
  variant?: string | null;
  temperature?: number | null;
  top_p?: number | null;
  prompt?: string | null;
  permission?: unknown;
  scope?: AgentScope;
};

const sortRules = (rules: PermissionRule[]): PermissionRule[] => (
  [...rules].sort((a, b) => {
    const permissionCompare = a.permission.localeCompare(b.permission);
    if (permissionCompare !== 0) return permissionCompare;
    return a.pattern.localeCompare(b.pattern);
  })
);

export const arePermissionRulesEqual = (a: PermissionRule[], b: PermissionRule[]): boolean => {
  const sortedA = sortRules(a);
  const sortedB = sortRules(b);
  if (sortedA.length !== sortedB.length) {
    return false;
  }
  return sortedA.every((rule, index) => {
    const other = sortedB[index];
    return rule.permission === other.permission
      && rule.pattern === other.pattern
      && rule.action === other.action;
  });
};

export const hasPermissionChanged = (
  current: Pick<AgentEditorSnapshot, 'globalPermission' | 'permissionRules'>,
  initial: Pick<AgentEditorSnapshot, 'globalPermission' | 'permissionRules'> | null | undefined,
): boolean => {
  if (!initial) {
    return false;
  }
  return current.globalPermission !== initial.globalPermission
    || !arePermissionRulesEqual(current.permissionRules, initial.permissionRules);
};

const encodeModel = (model: string): string | null => {
  const trimmed = model.trim();
  return trimmed === '' ? null : trimmed;
};

const encodeVariant = (variant: string): string | null | undefined => {
  const trimmed = variant.trim();
  if (trimmed === '') {
    return null;
  }
  return trimmed;
};

const encodePromptForCreate = (prompt: string): string | undefined => {
  const trimmed = prompt.trim();
  return trimmed || undefined;
};

const encodePromptForUpdate = (prompt: string): string | null => {
  const trimmed = prompt.trim();
  return trimmed || null;
};

/**
 * Build the agent mutation payload from only intentional values.
 *
 * - Create: send the drafted agent values, but omit permission unless the draft
 *   already carried one (duplicate) or the user edited permissions.
 * - Update: send only fields that differ from the loaded baseline. Server-side
 *   config merge already owns unchanged fields, so prompt-only edits must not
 *   rewrite permission/model/etc.
 */
export const buildAgentSaveConfig = ({
  isNewAgent,
  agentName,
  draftScope,
  draftHasExplicitPermission,
  current,
  initial,
  permissionConfig,
}: {
  isNewAgent: boolean;
  agentName: string;
  draftScope?: AgentScope;
  draftHasExplicitPermission: boolean;
  current: AgentEditorSnapshot;
  initial: AgentEditorSnapshot | null;
  permissionConfig: unknown;
}): AgentSaveConfig => {
  if (isNewAgent) {
    const permissionsChanged = hasPermissionChanged(current, initial);
    const shouldWritePermission = permissionsChanged || draftHasExplicitPermission;
    const description = current.description.trim();
    const model = encodeModel(current.model);
    const variant = encodeVariant(current.variant);
    const prompt = encodePromptForCreate(current.prompt);

    return {
      name: agentName,
      mode: current.mode,
      ...(description ? { description } : {}),
      ...(model ? { model } : {}),
      ...(variant ? { variant } : {}),
      ...(current.temperature !== undefined ? { temperature: current.temperature } : {}),
      ...(current.topP !== undefined ? { top_p: current.topP } : {}),
      ...(prompt ? { prompt } : {}),
      ...(shouldWritePermission ? { permission: permissionConfig } : {}),
      ...(draftScope ? { scope: draftScope } : {}),
    };
  }

  // Update: only fields that actually changed from the loaded baseline.
  const config: AgentSaveConfig = { name: agentName };
  if (!initial) {
    return config;
  }

  if (current.description !== initial.description) {
    const description = current.description.trim();
    if (description) {
      config.description = description;
    }
  }

  if (current.mode !== initial.mode) {
    config.mode = current.mode;
  }

  if (current.model !== initial.model) {
    config.model = encodeModel(current.model);
  }

  if (current.variant !== initial.variant) {
    config.variant = encodeVariant(current.variant) ?? null;
  }

  if (current.temperature !== initial.temperature) {
    config.temperature = current.temperature ?? null;
  }

  if (current.topP !== initial.topP) {
    config.top_p = current.topP ?? null;
  }

  if (current.prompt !== initial.prompt) {
    config.prompt = encodePromptForUpdate(current.prompt);
  }

  if (hasPermissionChanged(current, initial)) {
    config.permission = permissionConfig;
  }

  return config;
};
