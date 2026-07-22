import { describe, expect, test } from 'bun:test';
import { compileComposerSendPlan, transformDirectSendPlan, type ComposerSendPlan } from './send-plan';
import { collectSessionMentionIds, replaceSessionMentionTokens } from '@/components/chat/fileMentionAutocompleteState';
import { partitionComposerSemantics } from './delivery';

describe('direct composer send plan', () => {
    test('keeps a compact paste payload opaque without authored semantics', () => {
        const compiled = compileComposerSendPlan({ text: '[Paste 1]', references: [{ id: 'paste', kind: 'paste', text: '/undo @agent @file /skill @session:opaque', characterCount: 41, index: 1, display: '[Paste 1]', start: 0, end: 9 }] }, 'direct-send-display');
        if (!compiled.ok) throw new Error('Expected direct plan');
        const transformed = transformDirectSendPlan(compiled.plan, { transformAuthored: (text) => ({ text: `changed:${text}`, result: text }) });
        expect(transformed).toEqual({ text: '/undo @agent @file /skill @session:opaque', authoredResults: [], allAuthored: false });
    });

    test('transforms only authored chunks and trims authored boundaries', () => {
        const plan: ComposerSendPlan = { semantics: [], chunks: [
            { provenance: 'authored', text: '\nfirst\n', start: 0, end: 7 },
            { provenance: 'reference-payload', text: '\npayload\n', start: 7, end: 16, referenceId: 'paste' },
            { provenance: 'authored', text: '\nlast\n', start: 16, end: 22 },
        ] };
        const transformed = transformDirectSendPlan(plan, { transformAuthored: (text) => ({ text: text.toUpperCase(), result: text }) });
        expect(transformed).toEqual({ text: 'FIRST\n\npayload\n\nLAST', authoredResults: ['first\n', '\nlast'], allAuthored: false });
    });

    test('keeps session sidecar display while resolving authored canonical session tokens', () => {
        const plan: ComposerSendPlan = { semantics: [{ type: 'session', sessionId: 'sidecar' }], chunks: [
            { provenance: 'generated-reference', text: '@Sidecar session', start: 0, end: 16, referenceId: 'sidecar', semantic: { type: 'session', sessionId: 'sidecar' } },
            { provenance: 'authored', text: ' compare @session:legacy', start: 16, end: 40 },
        ] };
        const semantics = [...plan.semantics];
        const transformed = transformDirectSendPlan(plan, { transformAuthored: (text) => {
            const ids = collectSessionMentionIds(text);
            semantics.push(...ids.map((sessionId) => ({ type: 'session' as const, sessionId })));
            return { text, result: { hasLegacySessionTokens: ids.length > 0 } };
        } });
        const resolved = transformed.authoredResults.some((result) => result.hasLegacySessionTokens)
            ? replaceSessionMentionTokens(transformed.text, new Map([['legacy', 'Legacy session']]))
            : transformed.text;
        expect(resolved).toBe('@Sidecar session compare @Legacy session');
        expect(partitionComposerSemantics([...semantics, { type: 'session', sessionId: 'legacy' }]).sessionIds).toEqual(['sidecar', 'legacy']);
    });

    test('keeps durable skill and command tags opaque with no synthetic semantics', () => {
        const compiled = compileComposerSendPlan({ text: '/review /run', references: [
            { id: 'skill', kind: 'skill', skillName: 'review', display: '/review', start: 0, end: 7 },
            { id: 'command', kind: 'command', commandName: 'run', reference: 'task-42', display: '/run', start: 8, end: 12 },
        ] });
        expect(compiled.ok && compiled.plan).toEqual({ chunks: [
            { provenance: 'reference-payload', text: '[skill:review]', start: 0, end: 7, referenceId: 'skill' },
            { provenance: 'authored', text: ' ', start: 7, end: 8 },
            { provenance: 'reference-payload', text: '[command:task-42]', start: 8, end: 12, referenceId: 'command' },
        ], semantics: [] });
    });
});
