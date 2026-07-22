import { expect, mock, test } from 'bun:test';
import type { AttachedFile } from '@/stores/types/sessionTypes';

mock.module('@/sync/sync-refs', () => ({
    getSyncSessions: () => [{ id: 'ses_1', title: 'Prior work' }],
    getSyncMessages: () => [],
    getSyncParts: () => [],
    resolveMaterializedSessionDirectory: (_sessionId: string, directory?: string) => directory ?? null,
}));

const { buildAssistantQueueDeliveryParts, buildAssistantQueueSyntheticSidecar, buildSyntheticDeliveryParts, compileChatComposerDelivery, legacyTextToAuthoredPlan } = await import('./chatComposerDelivery');

const agents = [{ name: 'worker', mode: 'subagent' }] as never;
const citation = {
    id: 'citation',
    filename: 'pick.ts:1-2',
    mimeType: 'text/plain',
    size: 0,
    source: 'vscode',
    vscodeSource: 'selection',
    vscodePath: 'src/pick.ts',
} as never;

test('direct compiler resolves authored delivery references', () => {
    const compiled = compileChatComposerDelivery({
        plan: {
            chunks: [{ provenance: 'authored', text: '\n@worker inspect @src/a.ts /review @session:ses_1 [pick.ts:1-2]\n', start: 0, end: 70 }],
            semantics: [],
        },
        agents,
        installedSkillNames: new Set(['review']),
        directory: '/project',
        root: '/project',
        confirmedFilePaths: ['src/a.ts'],
        citationAttachments: [citation],
    });

    expect(compiled.text).toBe('@worker inspect @src/a.ts /review @Prior work [src/pick.ts:1-2]');
    expect(compiled.agent).toBe('worker');
    expect(compiled.attachments.map((attachment) => attachment.serverPath)).toEqual(['/project/src/a.ts']);
    expect(compiled.attachments[0]?.dataUrl).toBe('file:///project/src/a.ts');
    expect(compiled.semantics).toEqual([
        { type: 'skill', skillName: 'review' },
        { type: 'session', sessionId: 'ses_1' },
    ]);
});

test('manual and auto legacy delivery compile text-only queue content', () => {
    for (const plan of [legacyTextToAuthoredPlan('@worker @src/file.ts /review @session:ses_1'), legacyTextToAuthoredPlan('@worker @src/file.ts')]) {
        const compiled = compileChatComposerDelivery({
            plan,
            agents,
            installedSkillNames: new Set(['review']),
            directory: '/project',
            root: '/project',
        });
        expect(compiled.agent).toBe('worker');
        expect(compiled.attachments[0]?.serverPath).toBe('/project/src/file.ts');
    }
});

test('confirmed directory mentions send application/x-directory mime', () => {
    const compiled = compileChatComposerDelivery({
        plan: legacyTextToAuthoredPlan('update @opencode config'),
        agents,
        installedSkillNames: new Set(),
        directory: '/Users/yee.wang/.config',
        root: '/Users/yee.wang/.config',
        confirmedFilePaths: ['opencode'],
        confirmedDirectoryPaths: ['opencode'],
    });

    expect(compiled.attachments).toHaveLength(1);
    expect(compiled.attachments[0]?.serverPath).toBe('/Users/yee.wang/.config/opencode');
    expect(compiled.attachments[0]?.mimeType).toBe('application/x-directory');
    expect(compiled.attachments[0]?.filename).toBe('opencode');
});

test('compiler preserves Paste payload bytes while resolving authored session tokens', () => {
    const paste = '@session:ses_1 /review\n\n';
    const compiled = compileChatComposerDelivery({
        plan: {
            chunks: [
                { provenance: 'authored', text: '\nBefore @session:ses_1\n', start: 0, end: 23 },
                { provenance: 'reference-payload', text: paste, start: 23, end: 23 + paste.length, referenceId: 'paste' },
                { provenance: 'authored', text: '\nAfter\n', start: 23 + paste.length, end: 30 + paste.length },
            ],
            semantics: [],
        },
        agents,
        installedSkillNames: new Set(['review']),
        directory: '/project',
        root: '/project',
    });

    expect(compiled.text).toBe(`Before @Prior work\n${paste}\nAfter`);
    expect(compiled.semantics).toEqual([{ type: 'session', sessionId: 'ses_1' }]);
});

test('Assistant queue delivery serializes @session and /skill semantics as DTO text parts', () => {
    const deliveryParts = buildAssistantQueueDeliveryParts({
        text: '@Prior work /review',
        attachments: [],
        semanticParts: [
            { text: '[skill:review]', synthetic: true },
            { text: 'session context', synthetic: true },
        ],
        syntheticParts: [{ text: 'draft context' }],
    });

    expect(deliveryParts).toEqual([
        { type: 'text', text: '@Prior work /review' },
        { type: 'text', text: '[skill:review]', synthetic: true },
        { type: 'text', text: 'session context', synthetic: true },
        { type: 'text', text: 'draft context', synthetic: true },
    ]);
});

test('Assistant synthetic edit sidecar binds text and attachments to delivery indexes', () => {
    const attachment = { id: 'context-file', file: new File(['x'], 'context.bin'), dataUrl: 'data:application/octet-stream;base64,eA==', mimeType: 'application/octet-stream', filename: 'context.bin', size: 1, source: 'local' } as never;
    const syntheticParts = [{ partID: 'context', text: 'draft context', synthetic: true, attachments: [attachment] }];
    const deliveryParts = buildAssistantQueueDeliveryParts({ text: 'prompt', attachments: [], semanticParts: [{ text: 'session context', synthetic: true }], syntheticParts });
    expect(buildAssistantQueueSyntheticSidecar(deliveryParts, syntheticParts)).toEqual([{ partID: 'context', text: 'draft context', synthetic: true, attachmentIDs: ['context-file'], deliveryPartIndexes: [2, 3] }]);
});

test('direct-send synthetic context keeps text, file URLs, part order, and deduped attachments for recovery', () => {
    const shared: AttachedFile = { id: 'shared', file: new File(['x'], 'shared.txt'), dataUrl: 'file:///project/shared.txt', mimeType: 'text/plain', filename: 'shared.txt', size: 1, source: 'server', serverPath: '/project/shared.txt' };
    const duplicate = { ...shared, id: 'duplicate' };
    const unique: AttachedFile = { id: 'unique', file: new File(['y'], 'unique.txt'), dataUrl: 'file:///project/unique.txt', mimeType: 'text/plain', filename: 'unique.txt', size: 1, source: 'server', serverPath: '/project/unique.txt' };
    const syntheticParts = [
        { text: 'first synthetic text', attachments: [shared, duplicate] },
        { text: 'second synthetic text', attachments: [unique] },
    ];

    const deliveryParts = buildSyntheticDeliveryParts(syntheticParts);

    expect(deliveryParts).toEqual([
        { text: 'first synthetic text', attachments: [shared], synthetic: true },
        { text: 'second synthetic text', attachments: [unique], synthetic: true },
    ]);
    expect(deliveryParts.flatMap((part) => part.attachments ?? []).map((attachment) => attachment.dataUrl)).toEqual([
        'file:///project/shared.txt',
        'file:///project/unique.txt',
    ]);
    expect(syntheticParts).toEqual([
        { text: 'first synthetic text', attachments: [shared, duplicate] },
        { text: 'second synthetic text', attachments: [unique] },
    ]);
});
