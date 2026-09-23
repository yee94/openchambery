export type PermissionAction = 'allow' | 'ask' | 'deny';
export type PermissionRule = { permission: string; pattern: string; action: PermissionAction };
export type AgentMode = 'primary' | 'subagent' | 'all';
type AgentScope = 'user' | 'project';

export type AgentEditorSnapshot = {
  description: string;
  mode: AgentMode;
  model: string;
  system: string;
  globalPermission: PermissionAction;
  permissionRules: PermissionRule[];
};

export type NativePermission = { action: string; resource: string; effect: PermissionAction };

type AgentSaveConfig = {
  name: string;
  description?: string | null;
  mode?: AgentMode;
  model?: string | null;
  system?: string | null;
  permissions?: NativePermission[] | null;
  scope?: AgentScope;
  confirmDrop?: boolean;
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const PROMPT_FILE = /^\{file:.+\}$/i;

const sortRules = (rules: PermissionRule[]): PermissionRule[] => (
  [...rules].sort((a, b) => {
    const permissionCompare = a.permission.localeCompare(b.permission);
    if (permissionCompare !== 0) return permissionCompare;
    return a.pattern.localeCompare(b.pattern);
  })
);

const arePermissionRulesEqual = (a: PermissionRule[], b: PermissionRule[]): boolean => {
  const sortedA = sortRules(a);
  const sortedB = sortRules(b);
  if (sortedA.length !== sortedB.length) return false;
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
  if (!initial) return false;
  return current.globalPermission !== initial.globalPermission
    || !arePermissionRulesEqual(current.permissionRules, initial.permissionRules);
};

const renamePermission = (name: string): string => {
  if (name === 'bash') return 'shell';
  if (name === 'task') return 'subagent';
  if (name === 'write' || name === 'patch') return 'edit';
  return name;
};

const toNativePermissions = (
  globalPermission: PermissionAction,
  rules: PermissionRule[],
): NativePermission[] => {
  const native: NativePermission[] = [{ action: '*', resource: '*', effect: globalPermission }];
  for (const rule of rules) {
    if (!rule.permission || !rule.pattern) continue;
    if (rule.permission === '*' && rule.pattern === '*') continue;
    native.push({
      action: renamePermission(rule.permission),
      resource: rule.pattern,
      effect: rule.action,
    });
  }
  return native;
};

const encodeModel = (model: string): string | null => {
  const trimmed = model.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * Build a native agent patch.
 * Create sends the drafted values. Update sends only fields that differ.
 * Permission is omitted on create unless the draft already had rules or the user edited them.
 */
export const buildAgentSaveConfig = ({
  isNewAgent,
  agentName,
  draftScope,
  initialScope,
  draftHasExplicitPermission,
  current,
  initial,
  confirmDrop,
}: {
  isNewAgent: boolean;
  agentName: string;
  draftScope?: AgentScope;
  initialScope?: AgentScope;
  draftHasExplicitPermission: boolean;
  current: AgentEditorSnapshot;
  initial: AgentEditorSnapshot | null;
  confirmDrop?: boolean;
}): AgentSaveConfig => {
  const permissions = toNativePermissions(current.globalPermission, current.permissionRules);

  if (isNewAgent) {
    const description = current.description.trim();
    const model = encodeModel(current.model);
    const system = current.system.trim();
    const permissionsChanged = hasPermissionChanged(current, initial);
    const shouldWritePermission = permissionsChanged || draftHasExplicitPermission;
    return {
      name: agentName,
      mode: current.mode,
      ...(description ? { description } : {}),
      ...(model ? { model } : {}),
      ...(system ? { system } : {}),
      ...(shouldWritePermission ? { permissions } : {}),
      ...(draftScope ? { scope: draftScope } : {}),
      ...(confirmDrop ? { confirmDrop: true } : {}),
    };
  }

  const config: AgentSaveConfig = {
    name: agentName,
    ...(confirmDrop ? { confirmDrop: true } : {}),
  };
  if (!initial) return config;

  if (current.description !== initial.description) {
    const description = current.description.trim();
    config.description = description || null;
  }
  if (current.mode !== initial.mode) config.mode = current.mode;
  if (current.model !== initial.model) config.model = encodeModel(current.model);
  if (current.system !== initial.system) {
    const system = current.system.trim();
    config.system = system || null;
  }
  if (hasPermissionChanged(current, initial)) config.permissions = permissions;
  if (draftScope && initialScope && draftScope !== initialScope) config.scope = draftScope;
  return config;
};

export const readStoredSystem = (config: Record<string, unknown> | null | undefined): string | undefined => {
  if (!config) return undefined;
  if (typeof config.prompt === 'string') {
    if (PROMPT_FILE.test(config.prompt.trim())) return undefined;
    return config.prompt;
  }
  if (typeof config.system === 'string') return config.system;
  return undefined;
};

export const catalogModelSelection = (agent: {
  model?: { providerID?: string; modelID?: string; id?: string; variant?: string } | null;
  variant?: string | null;
} | null | undefined): string => {
  const providerID = agent?.model?.providerID;
  const modelID = agent?.model?.modelID || agent?.model?.id;
  if (!providerID || !modelID) return '';
  const variant = agent?.model?.variant || agent?.variant;
  return variant ? `${providerID}/${modelID}#${variant}` : `${providerID}/${modelID}`;
};

export const splitModelSelection = (value: string): { providerId: string; modelId: string; variant: string } | null => {
  const trimmed = value.trim();
  const separator = trimmed.indexOf('/');
  if (separator <= 0 || separator >= trimmed.length - 1) return null;
  const providerId = trimmed.slice(0, separator);
  const rest = trimmed.slice(separator + 1);
  const hash = rest.indexOf('#');
  if (hash === -1) return { providerId, modelId: rest, variant: '' };
  return { providerId, modelId: rest.slice(0, hash), variant: rest.slice(hash + 1) };
};

export const isHexColor = (value: string): boolean => HEX_COLOR.test(value.trim());

/** Display label for an agent id (build → Build). Storage ids stay lowercase. */
export const formatAgentDisplayName = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
};
