import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from '@/lib/messages/providerAuthError';

export type AssistantErrorVariant = 'error' | 'info' | 'muted';

export interface AssistantErrorPresentation {
    text: string;
    variant: AssistantErrorVariant;
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
    };
    const dataMessage = typeof errorInfo.data?.message === 'string' ? errorInfo.data.message : undefined;
    const errorMessage = typeof errorInfo.message === 'string' ? errorInfo.message : undefined;
    const errorName = typeof errorInfo.name === 'string' ? errorInfo.name : undefined;
    const detail = dataMessage || errorMessage || errorName;
    if (!detail) {
        return undefined;
    }

    if (errorName === 'SessionRetry') {
        return {
            text: `Opencode failed to send a message. Retry attempt info: \n\`${detail}\``,
            variant: 'info',
        };
    }

    if (isLikelyProviderAuthFailure(detail)) {
        return {
            text: PROVIDER_AUTH_FAILURE_MESSAGE,
            variant: 'error',
        };
    }

    if (errorName === 'MessageAbortedError' || detail.trim().toLowerCase() === 'aborted') {
        return {
            text: abortedText,
            variant: 'muted',
        };
    }

    return {
        text: `Opencode failed to send message with error:\n\`${detail}\``,
        variant: 'error',
    };
}
