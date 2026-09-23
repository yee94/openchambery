import { describe, expect, test } from 'vitest';
import { dict as en } from '@/lib/i18n/messages/en';
import { dict as zh } from '@/lib/i18n/messages/zh-CN';
import type { I18nKey } from '@/lib/i18n';
import { normalizeSessionProjectionMessage } from '@/sync/session-projection-api';
import { summarizeOpenCodeError } from '@/sync/session-error-log';
import { normalizeUserDisplayParts } from './normalizeUserDisplayParts';
import { resolveAssistantErrorPresentation, resolveRestartNotice, shouldSuppressAssistantError } from './assistantErrorPresentation';

const t = (key: I18nKey) => en[key];
const chinese = (key: I18nKey) => zh[key];

describe('official OpenCode response errors', () => {
    test.each([
        ['provider.rate-limit', 'rateLimit'], ['provider.auth', 'auth'], ['provider.quota', 'quota'],
        ['provider.content-filter', 'contentFilter'], ['provider.transport', 'transport'],
        ['provider.internal', 'internal'], ['provider.invalid-output', 'invalidOutput'],
        ['provider.invalid-request', 'invalidRequest'], ['provider.unsupported-operation', 'unsupportedOperation'],
        ['provider.no-route', 'noRoute'], ['provider.unknown', 'providerUnknown'], ['provider.timeout', 'timeout'],
        ['permission.rejected', 'permissionRejected'], ['tool.execution', 'toolExecution'],
        ['compaction.failed', 'compactionFailed'], ['compaction.unavailable', 'compactionUnavailable'],
        ['compaction.interrupted', 'compactionInterrupted'],
    ])('%s has a localized label and retains original diagnostics through both consumers', (type, key) => {
        const error = { type, message: 'specific upstream diagnosis', status: 503 };
        const presentation = resolveAssistantErrorPresentation(error, chinese);
        expect(presentation?.text).toBe(zh[`chat.response.${key}` as I18nKey]);
        expect(presentation?.rawMessage).toBe(error.message);
        expect(presentation?.detail).toBe(`${type} · 503`);
        expect(resolveAssistantErrorPresentation(summarizeOpenCodeError(error), chinese)).toEqual(presentation);
    });

    test('distinguishes generic interruption, user stop and exhausted restart recovery', () => {
        expect(resolveAssistantErrorPresentation({ type: 'aborted', message: 'Step interrupted' }, chinese))
            .toMatchObject({ text: '本次响应已中断', icon: 'pause-circle', variant: 'muted' });
        expect(resolveAssistantErrorPresentation({ type: 'aborted', message: 'Session interrupted by user' }, chinese))
            .toMatchObject({ text: '用户已停止生成', icon: 'stop-circle', variant: 'muted' });
        expect(resolveAssistantErrorPresentation({ type: 'aborted', message: 'Execution was interrupted repeatedly and will not be resumed automatically.' }, chinese))
            .toMatchObject({ text: '执行反复中断，已停止自动恢复', icon: 'error-warning', variant: 'error' });
        expect(resolveAssistantErrorPresentation({ type: 'aborted', message: 'future interruption reason' }, t)?.rawMessage)
            .toBe('future interruption reason');
    });

    test('does not infer automatic retry from rate limit or timeout errors', () => {
        for (const type of ['provider.rate-limit', 'provider.timeout', 'provider.transport']) {
            expect(resolveAssistantErrorPresentation({ type, message: 'failed' }, t)?.variant).toBe('error');
        }
        expect(resolveAssistantErrorPresentation({ name: 'SessionRetry', message: 'retrying' }, t))
            .toMatchObject({ text: en['chat.response.retrying'], variant: 'info', icon: 'refresh' });
    });

    test('structured type wins over misleading text; unknown errors remain diagnosable', () => {
        expect(resolveAssistantErrorPresentation({ type: 'provider.invalid-request', message: 'unauthorized field' }, t)?.text)
            .toBe(en['chat.response.invalidRequest']);
        expect(resolveAssistantErrorPresentation({ type: 'provider.future', message: 'new failure', status: 502 }, t))
            .toMatchObject({ text: en['chat.response.failed'], rawMessage: 'new failure', detail: 'provider.future · 502' });
        expect(resolveAssistantErrorPresentation({ message: 'token refresh failed' }, t)?.text).toBe(en['chat.response.auth']);
        expect(resolveAssistantErrorPresentation({ name: 'MessageAbortedError', data: { message: 'aborted' } }, t)?.icon).toBe('stop-circle');
        expect(resolveAssistantErrorPresentation({}, t)).toBeUndefined();
        expect(resolveAssistantErrorPresentation(undefined, t)).toBeUndefined();
        expect(resolveAssistantErrorPresentation({ type: 'provider.auth' }, t)?.text).toBe(en['chat.response.auth']);
        expect(resolveAssistantErrorPresentation({ type: 'unknown', message: 'failure', status: 999 }, t)?.detail).toBeUndefined();
    });

    test('restart notice survives projection while its model-facing instruction remains hidden', () => {
        const row = normalizeSessionProjectionMessage('ses_test', {
            id: 'msg_restart', type: 'synthetic', time: { created: 100 },
            description: 'Continuing after restart',
            text: 'The server restarted while you were working. Continue from where you left off without repeating completed work.',
        });
        expect(row).toBeDefined();
        expect(normalizeUserDisplayParts(row!.parts)).toEqual([]);
        expect(resolveRestartNotice(row!.info, chinese)).toEqual({ text: '重启后继续', icon: 'restart', variant: 'info' });
        expect(resolveRestartNotice({ role: 'user', description: 'Continuing after restart' }, t)).toBeUndefined();
        expect(resolveRestartNotice({ nativeType: 'synthetic', description: 'background completion' }, t)).toBeUndefined();
        expect(shouldSuppressAssistantError(false)).toBe(true);
        expect(shouldSuppressAssistantError(true)).toBe(false);
    });

    test.each(['zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pl', 'pt-BR', 'uk'])('%s supplies real translations for every response status', async (locale) => {
        const { dict } = await import(`../../../lib/i18n/messages/${locale}.ts`);
        for (const key of Object.keys(en).filter((key) => key.startsWith('chat.response.')) as I18nKey[]) {
            expect(dict[key], key).toBeTruthy();
            expect(dict[key], key).not.toBe(en[key]);
        }
    });
});
