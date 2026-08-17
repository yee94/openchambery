import { expect, test } from 'bun:test';
import { buildSessionMentionInstruction, buildSkillMentionInstruction, compileAuthoredDeliveryPlan, parseSessionMentionInstruction, partitionComposerSemantics, type SessionMentionContext } from './delivery';

test('delivery partitions semantic references with stable type-local deduplication', () => {
    expect(partitionComposerSemantics([
        { type: 'session', sessionId: 's1' },
        { type: 'skill', skillName: 'review' },
        { type: 'session', sessionId: 's1' },
        { type: 'attachment', attachmentRefID: 'a1' },
        { type: 'skill', skillName: 'review' },
    ])).toEqual({ sessionIds: ['s1'], skillNames: ['review'], attachmentRefIDs: ['a1'] });
});

test('delivery emits compact canonical tags for legacy skill semantics', () => {
    expect(buildSkillMentionInstruction(['review', 'test'])).toBe('[skill:review] [skill:test]');
});

test('delivery keeps session reference JSON parseable and lightweight', () => {
    const instruction = buildSessionMentionInstruction([
        { id: 's1', title: 'One' },
        { id: 's2', title: 'Two' },
    ]);
    const payload = instruction?.slice((instruction.indexOf('\n') ?? -1) + 1) ?? '';
    expect((JSON.parse(payload) as Array<{ id: string }>).map((context) => context.id)).toEqual(['s1', 's2']);
    expect(JSON.parse(payload)).toEqual([{ id: 's1', title: 'One' }, { id: 's2', title: 'Two' }]);
});

test('delivery recovers session reference metadata from instructions', () => {
    const contexts = [{ id: 's1', title: 'OpenChamber status' }];
    const instruction = buildSessionMentionInstruction(contexts);
    expect(parseSessionMentionInstruction(instruction ?? '')).toEqual(contexts);
    expect(parseSessionMentionInstruction('ordinary text')).toEqual([]);
    expect(parseSessionMentionInstruction(`${'The user referenced these OpenCode sessions.'.repeat(1)}\n{}`)).toEqual([]);
});

test('delivery caps session reference titles instead of dropping sessions', () => {
    const contexts = [{ id: 's1', title: 'x'.repeat(600) }];
    const instruction = buildSessionMentionInstruction(contexts, 100);
    const payload = instruction?.slice((instruction.indexOf('\n') ?? -1) + 1) ?? '';
    const parsed = JSON.parse(payload) as SessionMentionContext[];
    expect(parsed[0].title.length).toBe(103);
    expect(parsed[0].title.endsWith('...')).toBe(true);
});

test('delivery trims only authored document boundaries and deduplicates inline attachments', () => {
    const attachment = (id: string) => ({
        id,
        file: new File([], 'file.ts'),
        filename: 'file.ts',
        mimeType: 'text/plain',
        size: 0,
        dataUrl: 'file:///project/file.ts',
        source: 'server' as const,
        serverPath: '/project/file.ts',
    });
    const result = compileAuthoredDeliveryPlan({
        chunks: [
            { provenance: 'authored', text: '\nfirst\n', start: 0, end: 7 },
            { provenance: 'reference-payload', text: '\nopaque\n', start: 7, end: 15, referenceId: 'paste' },
            { provenance: 'authored', text: '\nlast\n', start: 15, end: 21 },
        ],
        semantics: [],
    }, (text) => ({ text, attachments: [attachment('first'), attachment('duplicate')] }));

    expect(result.text).toBe('first\n\nopaque\n\nlast');
    expect(result.attachments.map((item) => item.id)).toEqual(['first']);
});

test('delivery preserves reference-adjacent authored newlines', () => {
    const result = compileAuthoredDeliveryPlan({
        chunks: [
            { provenance: 'generated-reference', text: '@session', start: 0, end: 8, referenceId: 'session', semantic: { type: 'session', sessionId: 'session' } },
            { provenance: 'authored', text: '\nbody\n', start: 8, end: 14 },
            { provenance: 'reference-payload', text: '[Paste 1]', start: 14, end: 23, referenceId: 'paste' },
        ],
        semantics: [],
    }, (text) => ({ text }));
    expect(result.text).toBe('@session\nbody\n[Paste 1]');
});
