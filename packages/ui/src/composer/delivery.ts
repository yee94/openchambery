import { getSyncMessages, getSyncParts, getSyncSessions, resolveMaterializedSessionDirectory } from '@/sync/sync-refs';
import { isSyntheticPart } from '@/lib/messages/synthetic';
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

export type SessionMentionContext = { id: string; title: string; messages: Array<{ role: string; text: string }> };

const SESSION_MENTION_INSTRUCTION_PREFIX = 'The user explicitly referenced these loaded OpenCode sessions. Use their conversation content as context for this request. Some content may be omitted to fit the context limit.\n';

export const parseSessionMentionInstruction = (text: string): SessionMentionContext[] => {
    if (!text.startsWith(SESSION_MENTION_INSTRUCTION_PREFIX)) return [];
    try {
        const value: unknown = JSON.parse(text.slice(SESSION_MENTION_INSTRUCTION_PREFIX.length));
        if (!Array.isArray(value)) return [];
        return value.flatMap((item) => {
            if (!item || typeof item !== 'object') return [];
            const candidate = item as { id?: unknown; title?: unknown; messages?: unknown };
            if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string' || !Array.isArray(candidate.messages)) return [];
            const messages = candidate.messages.flatMap((message) => {
                if (!message || typeof message !== 'object') return [];
                const entry = message as { role?: unknown; text?: unknown };
                return typeof entry.role === 'string' && typeof entry.text === 'string'
                    ? [{ role: entry.role, text: entry.text }]
                    : [];
            });
            return [{ id: candidate.id, title: candidate.title, messages }];
        });
    } catch {
        return [];
    }
};

export const buildSkillMentionInstruction = (skillNames: readonly string[]): string | null => {
    if (skillNames.length === 0) return null;
    return skillNames.map((name) => `[skill:${name}]`).join(' ');
};

export const buildSessionMentionInstruction = (contexts: SessionMentionContext[], maxChars = 36_000): string | null => {
    if (contexts.length === 0) return null;
    const prefix = SESSION_MENTION_INSTRUCTION_PREFIX;
    const payloadBudget = maxChars - prefix.length;
    if (payloadBudget < 2) return prefix.slice(0, maxChars);

    const separatorsLength = contexts.length + 1;
    const contextBudget = Math.max(2, Math.floor((payloadBudget - separatorsLength) / contexts.length));
    const payloads = contexts.map((context) => {
        const fitted: SessionMentionContext = { id: context.id, title: context.title, messages: [] };
        if (JSON.stringify(fitted).length > contextBudget) {
            let low = 0; let high = fitted.title.length; let fittedTitle = '';
            while (low <= high) {
                const middle = Math.floor((low + high) / 2);
                const candidateTitle = `${fitted.title.slice(0, middle)}...`;
                if (JSON.stringify({ ...fitted, title: candidateTitle }).length <= contextBudget) { fittedTitle = candidateTitle; low = middle + 1; }
                else high = middle - 1;
            }
            fitted.title = fittedTitle;
        }
        for (const message of context.messages) {
            const nextMessages = [...fitted.messages, message];
            if (JSON.stringify({ ...fitted, messages: nextMessages }).length <= contextBudget) { fitted.messages = nextMessages; continue; }
            let low = 0; let high = message.text.length; let truncatedText = '';
            while (low <= high) {
                const middle = Math.floor((low + high) / 2);
                const candidateText = `${message.text.slice(0, middle)}\n[Message truncated]`;
                const candidate = { ...fitted, messages: [...fitted.messages, { ...message, text: candidateText }] };
                if (JSON.stringify(candidate).length <= contextBudget) { truncatedText = candidateText; low = middle + 1; }
                else high = middle - 1;
            }
            if (truncatedText) fitted.messages.push({ ...message, text: truncatedText });
            break;
        }
        return JSON.stringify(fitted);
    });
    return `${prefix}[${payloads.join(',')}]`;
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

/** Resolves semantic delivery at the owner boundary from the loaded directory snapshot. */
export const buildComposerSemanticParts = (semantics: readonly ComposerReferenceSemantic[], directory: string): Array<{ text: string; synthetic: true }> => {
    const { sessionIds, skillNames } = partitionComposerSemantics(semantics);
    const contexts: SessionMentionContext[] = sessionIds.flatMap((sessionId) => {
        const sessionDirectory = resolveMaterializedSessionDirectory(sessionId, directory);
        if (!sessionDirectory) return [];
        const session = getSyncSessions(sessionDirectory).find((candidate) => candidate.id === sessionId);
        if (!session) return [];
        const messages = getSyncMessages(sessionId, sessionDirectory).flatMap((message) => {
            const text = getSyncParts(message.id, sessionDirectory).filter((part) => part.type === 'text' && !isSyntheticPart(part)).map((part) => 'text' in part && typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n');
            return text ? [{ role: message.role, text }] : [];
        });
        return [{ id: session.id, title: session.title || session.id, messages }];
    });
    const parts: Array<{ text: string; synthetic: true }> = [];
    const skill = buildSkillMentionInstruction(skillNames);
    if (skill) parts.push({ text: skill, synthetic: true });
    const session = buildSessionMentionInstruction(contexts);
    if (session) parts.push({ text: session, synthetic: true });
    return parts;
};
