// Keep only tools with a direct in-app navigation destination compact. Every
// other tool uses ToolPart so custom, plugin, and MCP calls expose their input
// and output through the common expandable renderer.
const STATIC_TOOL_NAMES = new Set<string>(['read', 'skill']);

const STANDALONE_TOOL_NAMES = new Set<string>(['task']);

const CONTEXT_GROUP_TOOL_NAMES = new Set<string>(['read', 'glob', 'grep', 'list']);

const SETTLED_TOOL_STATUSES = new Set<string>([
    'completed',
    'error',
    'failed',
    'aborted',
    'timeout',
    'cancelled',
]);

const ACTIVE_TOOL_STATUSES = new Set<string>(['pending', 'started', 'running']);

const normalizeToolName = (toolName: unknown): string => {
    if (typeof toolName !== 'string') return '';
    const trimmed = toolName.trim().toLowerCase();
    if (!trimmed) return '';

    const withoutIndex = trimmed.replace(/:\d+$/, '');
    if (withoutIndex.includes('.')) {
        const parts = withoutIndex.split('.').filter(Boolean);
        return parts[parts.length - 1] ?? withoutIndex;
    }
    return withoutIndex;
};

export const isExpandableTool = (toolName: unknown): boolean => {
    return !isStaticTool(toolName);
};

export const isStandaloneTool = (toolName: unknown): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isStaticTool = (toolName: unknown): boolean => {
    return STATIC_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isContextGroupTool = (toolName: unknown): boolean => {
    return CONTEXT_GROUP_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isSkillGroupTool = (toolName: unknown): boolean => {
    return normalizeToolName(toolName) === 'skill';
};

// Task stays a standalone row (child-session chrome). Question stays visible
// because it waits on the user. Everything else that is not explore/skill
// collapses into the Used / 运行了 fold.
export const isUsedGroupTool = (toolName: unknown): boolean => {
    const name = normalizeToolName(toolName);
    if (!name) return false;
    if (CONTEXT_GROUP_TOOL_NAMES.has(name)) return false;
    if (name === 'skill' || STANDALONE_TOOL_NAMES.has(name) || name === 'question') {
        return false;
    }
    return true;
};

export const isToolPartSettled = (part: unknown): boolean => {
    if (!part || typeof part !== 'object') return false;

    const state = (part as { state?: unknown }).state;
    if (!state || typeof state !== 'object') return false;

    const status = (state as { status?: unknown }).status;
    if (typeof status === 'string') {
        const normalizedStatus = status.trim().toLowerCase();
        if (ACTIVE_TOOL_STATUSES.has(normalizedStatus)) return false;
        if (SETTLED_TOOL_STATUSES.has(normalizedStatus)) return true;
    }

    const time = (state as { time?: unknown }).time;
    if (!time || typeof time !== 'object') return false;

    const start = (time as { start?: unknown }).start;
    const end = (time as { end?: unknown }).end;
    if (typeof end !== 'number' || !Number.isFinite(end)) return false;
    return typeof start !== 'number' || !Number.isFinite(start) || end >= start;
};

export const isToolPartActive = (part: unknown): boolean => !isToolPartSettled(part);

export const normalizeContextToolName = normalizeToolName;
