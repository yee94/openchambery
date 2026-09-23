import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from '@/lib/messages/providerAuthError';

export type AssistantErrorVariant = 'error' | 'info' | 'muted';

export interface AssistantErrorPresentation {
    text: string;
    variant: AssistantErrorVariant;
    /** Raw OpenCode error code / HTTP status (`provider.auth · 401`), shown dimmed after `text`. */
    detail?: string;
}

const GENERIC_ERROR_TYPES = new Set(['error', 'unknown']);

function structuredErrorDetail(type: string | undefined, status: number | undefined): string | undefined {
    const parts = [
        type && !GENERIC_ERROR_TYPES.has(type) ? type : undefined,
        typeof status === 'number' && Number.isFinite(status) ? String(status) : undefined,
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function resolveAssistantErrorPresentation(
    error: unknown,
    abortedText: string,
): AssistantErrorPresentation | undefined {
    if (!error || typeof error !== 'object') {
        return undefined;
    }

    const errorInfo = error as {
        data?: { message?: unknown };
        message?: unknown;
        name?: unknown;
        type?: unknown;
        status?: unknown;
    };
    const dataMessage = typeof errorInfo.data?.message === 'string' ? errorInfo.data.message : undefined;
    const errorMessage = typeof errorInfo.message === 'string' ? errorInfo.message : undefined;
    const errorName = typeof errorInfo.name === 'string' ? errorInfo.name : undefined;
    const errorType = typeof errorInfo.type === 'string' ? errorInfo.type.trim() : undefined;
    const errorStatus = typeof errorInfo.status === 'number' ? errorInfo.status : undefined;
    const detail = dataMessage || errorMessage || errorName;
    if (!detail) {
        return undefined;
    }

    if (errorName === 'SessionRetry') {
        return {
            text: detail,
            variant: 'info',
        };
    }

    // OpenCode 2 marks user interrupts as `{ type: 'aborted', message: 'Step interrupted' }`.
    if (
        errorName === 'MessageAbortedError'
        || errorType === 'aborted'
        || detail.trim().toLowerCase() === 'aborted'
    ) {
        return {
            text: abortedText,
            variant: 'muted',
        };
    }

    const structuredDetail = structuredErrorDetail(errorType, errorStatus);

    if (isLikelyProviderAuthFailure(detail)) {
        return {
            text: PROVIDER_AUTH_FAILURE_MESSAGE,
            variant: 'error',
            ...(structuredDetail ? { detail: structuredDetail } : {}),
        };
    }

    return {
        text: detail,
        variant: 'error',
        ...(structuredDetail ? { detail: structuredDetail } : {}),
    };
}

/**
 * Earlier assistants in a turn are retries that a later sibling superseded.
 * Only the last assistant may surface an error; recovered attempts stay hidden.
 */
export function shouldSuppressAssistantError(isLastAssistantInTurn: boolean): boolean {
    return !isLastAssistantInTurn;
}
