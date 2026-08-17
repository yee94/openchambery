import { getAllSyncSessionMap, getSyncSessions } from '@/sync/sync-refs';
import type { ComposerReferenceSemantic } from './extensions';
import type { ComposerSendPlan } from './send-plan';
import type { AttachedFile } from '@/stores/types/sessionTypes';

export type AuthoredDeliveryResult = {
    text: string;
    agent?: string;
    attachments?: AttachedFile[];
    semantics?: ComposerReferenceSemantic[];
};

/** Compiles authored chunks while preserving generated references and payloads exactly. */
export const compileAuthoredDeliveryPlan = (
    plan: ComposerSendPlan,
    compileAuthored: (text: string) => AuthoredDeliveryResult,
): { text: string; agent?: string; attachments: AttachedFile[]; semantics: ComposerReferenceSemantic[] } => {
    let agent: string | undefined;
    const attachments: AttachedFile[] = [];
    const semantics = [...plan.semantics];
    const text = plan.chunks.map((chunk, index) => {
        if (chunk.provenance !== 'authored') return chunk.text;
        let authored = chunk.text;
        if (index === 0) authored = authored.replace(/^\n+/, '');
        if (index === plan.chunks.length - 1) authored = authored.replace(/\n+$/, '');
        const compiled = compileAuthored(authored);
        agent ??= compiled.agent;
        attachments.push(...(compiled.attachments ?? []));
        semantics.push(...(compiled.semantics ?? []));
        return compiled.text;
    }).join('');
    return { text, agent, attachments: dedupeDeliveryAttachments(attachments), semantics };
};

export const dedupeDeliveryAttachments = (attachments: readonly AttachedFile[]): AttachedFile[] => {
    const seen = new Set<string>();
    return attachments.filter((attachment) => {
        const serverPath = attachment.serverPath?.replace(/\\/g, '/').replace(/\/+/g, '/');
        const key = serverPath ? `path:${serverPath}` : `id:${attachment.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

export type SessionMentionContext = { id: string; title: string };

const SESSION_MENTION_INSTRUCTION_PREFIX = 'The user referenced these OpenCode sessions. Their conversation content is not inlined in this prompt; when the request depends on it, look the sessions up by ID and read them there instead of guessing from the title alone.\n';

export const parseSessionMentionInstruction = (text: string): SessionMentionContext[] => {
    if (!text.startsWith(SESSION_MENTION_INSTRUCTION_PREFIX)) return [];
    try {
        const value: unknown = JSON.parse(text.slice(SESSION_MENTION_INSTRUCTION_PREFIX.length));
        if (!Array.isArray(value)) return [];
        return value.flatMap((item) => {
            if (!item || typeof item !== 'object') return [];
            const candidate = item as { id?: unknown; title?: unknown };
            return typeof candidate.id === 'string' && typeof candidate.title === 'string'
                ? [{ id: candidate.id, title: candidate.title }]
                : [];
        });
    } catch {
        return [];
    }
};

export const buildSkillMentionInstruction = (skillNames: readonly string[]): string | null => {
    if (skillNames.length === 0) return null;
    return skillNames.map((name) => `[skill:${name}]`).join(' ');
};

/** Session references stay lightweight: only stable IDs plus display titles travel in the prompt. */
export const buildSessionMentionInstruction = (contexts: readonly SessionMentionContext[], maxTitleChars = 200): string | null => {
    if (contexts.length === 0) return null;
    const payload = contexts.map((context) => JSON.stringify({
        id: context.id,
        title: context.title.length > maxTitleChars ? `${context.title.slice(0, maxTitleChars)}...` : context.title,
    }));
    return `${SESSION_MENTION_INSTRUCTION_PREFIX}[${payload.join(',')}]`;
};

export const partitionComposerSemantics = (semantics: readonly ComposerReferenceSemantic[]) => {
    const sessionIds: string[] = [], skillNames: string[] = [], attachmentRefIDs: string[] = [];
    const seen = { session: new Set<string>(), skill: new Set<string>(), attachment: new Set<string>() };
    for (const semantic of semantics) {
        switch (semantic.type) {
            case 'session': if (!seen.session.has(semantic.sessionId)) { seen.session.add(semantic.sessionId); sessionIds.push(semantic.sessionId); } break;
            case 'skill': if (!seen.skill.has(semantic.skillName)) { seen.skill.add(semantic.skillName); skillNames.push(semantic.skillName); } break;
            case 'attachment': if (!seen.attachment.has(semantic.attachmentRefID)) { seen.attachment.add(semantic.attachmentRefID); attachmentRefIDs.push(semantic.attachmentRefID); } break;
        }
    }
    return { sessionIds, skillNames, attachmentRefIDs };
};

/** Resolves semantic delivery from loaded session summaries — no transcript reads, so an unopened or evicted referenced session still resolves. */
export const buildComposerSemanticParts = (semantics: readonly ComposerReferenceSemantic[], directory: string): Array<{ text: string; synthetic: true }> => {
    const { sessionIds, skillNames } = partitionComposerSemantics(semantics);
    const loadedSessions = sessionIds.length > 0 ? getAllSyncSessionMap() : undefined;
    const contexts: SessionMentionContext[] = sessionIds.flatMap((sessionId) => {
        const session = loadedSessions?.get(sessionId) ?? getSyncSessions(directory).find((candidate) => candidate.id === sessionId);
        if (!session) return [];
        return [{ id: session.id, title: session.title || session.id }];
    });
    const parts: Array<{ text: string; synthetic: true }> = [];
    const skill = buildSkillMentionInstruction(skillNames);
    if (skill) parts.push({ text: skill, synthetic: true });
    const session = buildSessionMentionInstruction(contexts);
    if (session) parts.push({ text: session, synthetic: true });
    return parts;
};
