import type { Part } from '@opencode-ai/sdk/v2';
import { isCodeSelectionFilePart } from '../attachmentCitations';
import { isEmptyTextPart } from './partUtils';

const GITHUB_ISSUE_CONTEXT_PREFIX = 'GitHub issue context (JSON)';
const GITHUB_PR_CONTEXT_PREFIX = 'GitHub pull request context (JSON)';

type GitHubIssueContextPayload = {
    issue?: {
        number?: unknown;
        title?: unknown;
        url?: unknown;
    };
};

type GitHubPrContextPayload = {
    pr?: {
        number?: unknown;
        title?: unknown;
        url?: unknown;
    };
};

const isPositiveNumber = (value: unknown): value is number => {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
};

const parseSyntheticJsonPayload = <T>(text: string, prefix: string): T | null => {
    const normalizedText = text.trimStart();
    if (!normalizedText.startsWith(prefix)) {
        return null;
    }

    const jsonStart = normalizedText.indexOf('{');
    if (jsonStart < 0) {
        return null;
    }

    try {
        return JSON.parse(normalizedText.slice(jsonStart)) as T;
    } catch {
        return null;
    }
};

const buildGitHubAttachmentPart = (text: string): Part | null => {
    const issuePayload = parseSyntheticJsonPayload<GitHubIssueContextPayload>(text, GITHUB_ISSUE_CONTEXT_PREFIX);
    if (issuePayload) {
        const issue = issuePayload.issue;
        const number = issue?.number;
        const title = issue?.title;
        const url = issue?.url;
        if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }

        return {
            type: 'file',
            mime: 'application/vnd.github.issue-link',
            filename: `Issue #${number}: ${title}`,
            url,
        } as Part;
    }

    const prPayload = parseSyntheticJsonPayload<GitHubPrContextPayload>(text, GITHUB_PR_CONTEXT_PREFIX);
    if (prPayload) {
        const pr = prPayload.pr;
        const number = pr?.number;
        const title = pr?.title;
        const url = pr?.url;
        if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }

        return {
            type: 'file',
            mime: 'application/vnd.github.pull-request-link',
            filename: `PR #${number}: ${title}`,
            url,
        } as Part;
    }

    return null;
};

const shouldKeepSyntheticUserText = (text: string): boolean => {
    const trimmed = text.trim();
    if (trimmed.startsWith('The following tool was executed by the user')) return true;
    return false;
};

/** Server goal auto-continuation (session-goal runtime). Never show as a user bubble. */
const isSessionGoalContinuationText = (text: string): boolean => {
    const trimmed = text.trimStart();
    return trimmed.startsWith('Continue working toward the active session goal.');
};

/** `/compact` is a session command, not a user-authored bubble. */
const isCompactionCommandText = (text: string): boolean => {
    return text.trim() === '/compact';
};

export const normalizeUserDisplayParts = (parts: Part[]): Part[] => {
    return parts
        .filter((part) => {
            if (part.type === 'compaction') {
                return false;
            }
            if (part.type === 'text') {
                const text = (part as { text?: unknown }).text;
                if (typeof text === 'string' && (
                    isSessionGoalContinuationText(text)
                    || isCompactionCommandText(text)
                )) {
                    return false;
                }
            }
            const synthetic = (part as { synthetic?: boolean }).synthetic === true;
            if (!synthetic) return true;
            if (part.type !== 'text') return false;
            const text = (part as { text?: unknown }).text;
            if (typeof text !== 'string') {
                return false;
            }

            const normalizedText = text.trimStart();
            return shouldKeepSyntheticUserText(text)
                || normalizedText.startsWith(GITHUB_ISSUE_CONTEXT_PREFIX)
                || normalizedText.startsWith(GITHUB_PR_CONTEXT_PREFIX);
        })
        .map((part) => {
            const rawPart = part as Record<string, unknown>;
            if (rawPart.type === 'text') {
                const text = typeof rawPart.text === 'string' ? rawPart.text.trim() : '';
                const synthetic = rawPart.synthetic === true;

                if (synthetic) {
                    const attachmentPart = buildGitHubAttachmentPart(text);
                    if (attachmentPart) {
                        return attachmentPart;
                    }
                }

                if (text.startsWith('The following tool was executed by the user')) {
                    return { type: 'text', text: '/shell' } as Part;
                }
            }
            return part;
        });
};

/**
 * Whether already-normalized display parts carry visible bubble content.
 * Hollow parts — empty/whitespace text, or file parts without mime/url, or
 * code-selection file parts — do not count as visible.
 */
export const hasVisibleUserBubbleContent = (parts: readonly Part[]): boolean => {
    return parts.some((part) => {
        if (part.type === 'text') {
            return !isEmptyTextPart(part);
        }
        if (part.type === 'file') {
            // FileAttachment keeps `(mime || url) && !codeSelection`. Hollow
            // image shells often land with mime before url and paint nothing,
            // so bubble visibility also requires a non-empty url.
            const file = part as { mime?: unknown; url?: unknown };
            const mime = typeof file.mime === 'string' ? file.mime : '';
            const url = typeof file.url === 'string' ? file.url : '';
            return (Boolean(mime) || Boolean(url)) && Boolean(url) && !isCodeSelectionFilePart(part);
        }
        return true;
    });
};

/**
 * Whether parts would paint a user bubble.
 * `ChatMessage` hides user rows when display parts are empty. Synthetic-only
 * shells (e.g. `<system-reminder>`) and hollow parts (empty text, file without
 * mime/url) count as present for `parts.length` but still render as null —
 * treat them as not yet materialized.
 */
export const hasUserDisplayableParts = (parts: readonly Part[] | undefined): boolean => {
    if (!parts?.length) return false;
    return hasVisibleUserBubbleContent(normalizeUserDisplayParts(parts as Part[]));
};
