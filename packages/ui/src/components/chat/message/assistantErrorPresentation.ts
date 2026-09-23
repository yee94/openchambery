import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import { isLikelyProviderAuthFailure } from '@/lib/messages/providerAuthError';

export type AssistantErrorVariant = 'error' | 'info' | 'muted';

export interface AssistantErrorPresentation {
    text: string;
    variant: AssistantErrorVariant;
    icon: IconName;
    /** Preserve upstream diagnostics separately from the localized status. */
    rawMessage?: string;
    detail?: string;
}

// OpenCode core/session/to-session-error.ts plus compaction.ts. The wire type is
// deliberately open-ended; unknown future codes must retain their diagnostics.
const ERROR_KEYS: Record<string, I18nKey> = {
    'provider.rate-limit': 'chat.response.rateLimit',
    'provider.auth': 'chat.response.auth',
    'provider.quota': 'chat.response.quota',
    'provider.content-filter': 'chat.response.contentFilter',
    'provider.transport': 'chat.response.transport',
    'provider.internal': 'chat.response.internal',
    'provider.invalid-output': 'chat.response.invalidOutput',
    'provider.invalid-request': 'chat.response.invalidRequest',
    'provider.unsupported-operation': 'chat.response.unsupportedOperation',
    'provider.no-route': 'chat.response.noRoute',
    'provider.unknown': 'chat.response.providerUnknown',
    'provider.timeout': 'chat.response.timeout',
    'permission.rejected': 'chat.response.permissionRejected',
    'tool.execution': 'chat.response.toolExecution',
    'compaction.failed': 'chat.response.compactionFailed',
    'compaction.unavailable': 'chat.response.compactionUnavailable',
    'compaction.interrupted': 'chat.response.compactionInterrupted',
};

const INTERRUPTED: Pick<AssistantErrorPresentation, 'icon' | 'variant'> = { icon: 'pause-circle', variant: 'muted' };

export function resolveAssistantErrorPresentation(
    error: unknown,
    t: (key: I18nKey) => string,
): AssistantErrorPresentation | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const value = error as { data?: { message?: unknown }; message?: unknown; name?: unknown; type?: unknown; status?: unknown };
    const message = typeof value.data?.message === 'string' ? value.data.message
        : typeof value.message === 'string' ? value.message : undefined;
    const name = typeof value.name === 'string' ? value.name : undefined;
    const type = typeof value.type === 'string' ? value.type.trim() : undefined;
    const status = typeof value.status === 'number' && Number.isInteger(value.status)
        && value.status >= 100 && value.status <= 599 ? value.status : undefined;
    if (!message && !type && !name && status === undefined) return undefined;
    const detail = [type && type !== 'unknown' && type !== 'error' ? type : undefined, status].filter((part) => part !== undefined).join(' · ') || undefined;
    const result = (key: I18nKey, icon: IconName, variant: AssistantErrorVariant = 'error', knownMessage = false): AssistantErrorPresentation => ({
        text: t(key), icon, variant,
        ...(message && !knownMessage ? { rawMessage: message } : {}),
        ...(detail ? { detail } : {}),
    });

    if (name === 'SessionRetry') return result('chat.response.retrying', 'refresh', 'info');
    if (type === 'aborted') {
        if (message === 'Execution was interrupted repeatedly and will not be resumed automatically.') {
            return result('chat.response.resumeExhausted', 'error-warning', 'error', true);
        }
        if (message === 'Session interrupted by user') return result('chat.response.stopped', 'stop-circle', 'muted', true);
        if (message === 'Compaction cancelled') return result('chat.response.compactionCancelled', 'stop-circle', 'muted', true);
        if (message === 'Tool execution interrupted') return result('chat.response.toolInterrupted', INTERRUPTED.icon, INTERRUPTED.variant, true);
        return result('chat.response.interrupted', INTERRUPTED.icon, INTERRUPTED.variant, message === 'Step interrupted');
    }
    if (name === 'MessageAbortedError' || (!type && message?.trim().toLowerCase() === 'aborted')) {
        return result('chat.response.stopped', 'stop-circle', 'muted', true);
    }
    if (type && Object.hasOwn(ERROR_KEYS, type)) {
        if (type === 'compaction.interrupted') return result(ERROR_KEYS[type], INTERRUPTED.icon, INTERRUPTED.variant, message === 'Compaction was interrupted');
        if (type === 'compaction.unavailable') return result(ERROR_KEYS[type], 'information', 'info', message === 'Nothing to compact yet');
        const icon: IconName = type === 'provider.auth' || type === 'permission.rejected' ? 'lock'
            : type === 'provider.timeout' ? 'time' : 'error-warning';
        return result(ERROR_KEYS[type], icon);
    }
    // Only unstructured legacy errors may use text-based authentication detection.
    if ((!type || type === 'unknown' || type === 'error') && isLikelyProviderAuthFailure(message)) {
        return result('chat.response.auth', 'lock');
    }
    return { ...result('chat.response.failed', 'error-warning'), ...(!message && name ? { rawMessage: name } : {}) };
}

export function resolveRestartNotice(
    info: unknown,
    t: (key: I18nKey) => string,
): AssistantErrorPresentation | undefined {
    if (!info || typeof info !== 'object') return undefined;
    const value = info as { nativeType?: unknown; description?: unknown };
    if (value.nativeType !== 'synthetic' || value.description !== 'Continuing after restart') return undefined;
    return { text: t('chat.response.continuingAfterRestart'), icon: 'restart', variant: 'info' };
}

/**
 * Earlier assistants in a turn are retries that a later sibling superseded.
 * Only the last assistant may surface an error; recovered attempts stay hidden.
 */
export function shouldSuppressAssistantError(isLastAssistantInTurn: boolean): boolean {
    return !isLastAssistantInTurn;
}
