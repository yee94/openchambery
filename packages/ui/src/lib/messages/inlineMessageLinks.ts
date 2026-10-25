const SKILL_LINK_PREFIX = '#yuri-skill:';
const AGENT_LINK_PREFIX = '#yuri-agent:';

export const buildAgentMentionUrl = (name: string): string => {
    const encoded = encodeURIComponent(name);
    return `https://opencode.ai/docs/agents/#${encoded}`;
};

export const buildSkillHref = (name: string): string => `${SKILL_LINK_PREFIX}${encodeURIComponent(name)}`;

export const buildAgentHref = (name: string): string => `${AGENT_LINK_PREFIX}${encodeURIComponent(name)}`;

export const parseSkillHref = (href: string | null | undefined): string | null => {
    const prefix = [SKILL_LINK_PREFIX, '#openchamber-skill:'].find((candidate) => href?.startsWith(candidate));
    if (!prefix || !href) return null;
    try {
        return decodeURIComponent(href.slice(prefix.length));
    } catch {
        return null;
    }
};

export const parseAgentHref = (href: string | null | undefined): string | null => {
    const prefix = [AGENT_LINK_PREFIX, '#openchamber-agent:'].find((candidate) => href?.startsWith(candidate));
    if (!prefix || !href) return null;
    try {
        return decodeURIComponent(href.slice(prefix.length));
    } catch {
        return null;
    }
};
