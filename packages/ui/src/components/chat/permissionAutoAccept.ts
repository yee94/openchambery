import { toPermissionRuleset } from '@/sync/permission-rules';

export type PermissionAutoAcceptToggleArgs = {
    permissionScopeSessionId: string | null;
    newSessionDraftOpen: boolean;
    draftPermissionAutoAcceptEnabled: boolean;
    permissionAutoAcceptEnabled: boolean;
    setDraftPermissionAutoAcceptEnabled: (enabled: boolean) => void;
    setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>;
    onOpenSessionFirst: () => void;
    onToggleFailed: () => void;
};

type PermissionAgent = {
    name?: unknown;
    /** Legacy / editor singular field (V1 map or flattened rules). */
    permission?: unknown;
    /** OpenCode v2 wire catalog field (`AgentInfo.permissions`). */
    permissions?: unknown;
};

/**
 * Prefer the V2 wire `permissions` field when present; otherwise the legacy
 * singular `permission` document. Empty arrays still count as present so a V2
 * agent with no rules does not fall through to a stale singular field.
 */
const agentPermissionConfig = (agent: PermissionAgent): unknown => (
    Object.prototype.hasOwnProperty.call(agent, 'permissions')
        ? agent.permissions
        : agent.permission
);

/**
 * True when any permission request can still reach the user (ask path remains).
 * Last-match: a trailing global action/resource wildcard allow or deny closes
 * every prompt path. Unrecognized or empty configs keep the control visible.
 */
const canPermissionRulesPrompt = (permission: unknown): boolean => {
    const rules = toPermissionRuleset(permission);
    for (let index = rules.length - 1; index >= 0; index -= 1) {
        const rule = rules[index];
        if (!rule) continue;
        if (rule.action === '*' && rule.resource === '*') return rule.effect === 'ask';
        if (rule.effect === 'ask') return true;
    }
    return true;
};

/** Unknown agent snapshots and configurations keep the control available. */
export const shouldShowPermissionAutoAcceptControl = (
    agents: readonly PermissionAgent[],
    currentAgentName: string | undefined,
): boolean => {
    const name = currentAgentName?.trim();
    if (!name) {
        return agents.length === 0 || agents.some((agent) => canPermissionRulesPrompt(agentPermissionConfig(agent)));
    }
    const agent = agents.find((entry) => entry?.name === name);
    return agent ? canPermissionRulesPrompt(agentPermissionConfig(agent)) : true;
};

export const togglePermissionAutoAccept = (args: PermissionAutoAcceptToggleArgs): void => {
    const {
        permissionScopeSessionId,
        newSessionDraftOpen,
        draftPermissionAutoAcceptEnabled,
        permissionAutoAcceptEnabled,
        setDraftPermissionAutoAcceptEnabled,
        setSessionAutoAccept,
        onOpenSessionFirst,
        onToggleFailed,
    } = args;

    if (!permissionScopeSessionId) {
        if (!newSessionDraftOpen) {
            onOpenSessionFirst();
            return;
        }

        setDraftPermissionAutoAcceptEnabled(!draftPermissionAutoAcceptEnabled);
        return;
    }

    const nextEnabled = !permissionAutoAcceptEnabled;
    void setSessionAutoAccept(permissionScopeSessionId, nextEnabled).catch(onToggleFailed);
};
