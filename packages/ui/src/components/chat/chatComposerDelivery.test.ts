import { beforeEach, expect, mock, test } from 'bun:test';
import type { AttachedFile } from '@/stores/types/sessionTypes';

let loadedSessions = new Map<string, { id: string; title: string }>();
mock.module('@/sync/sync-refs', () => ({
    getSyncSessions: () => [{ id: 'ses_1', title: 'Prior work' }],
    getSyncMessages: () => [],
    getSyncParts: () => [],
    getAllSyncSessionMap: () => loadedSessions,
    resolveMaterializedSessionDirectory: (_sessionId: string, directory?: string) => directory ?? null,
}));

const { buildAssistantQueueDeliveryParts, buildAssistantQueueSyntheticSidecar, buildSyntheticDeliveryParts, compileChatComposerDelivery, legacyTextToAuthoredPlan } = await import('./chatComposerDelivery');

const agents = [{ name: 'worker', mode: 'subagent' }] as never;
beforeEach(() => {
    loadedSessions = new Map([
        ['ses_1', { id: 'ses_1', title: 'Prior work' }],
        ['ses_2', { id: 'ses_2', title: 'Effect 和 Cordis 的 DI 对比' }],
    ]);
});
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

test('pasted visible @title references deliver session semantics without touching text', () => {
    const compiled = compileChatComposerDelivery({
        plan: legacyTextToAuthoredPlan('参考 @Effect 和 Cordis 的 DI 对比 的结论，补一章节'),
        agents,
        installedSkillNames: new Set(),
        directory: '/project',
        root: '/project',
    });

    expect(compiled.text).toBe('参考 @Effect 和 Cordis 的 DI 对比 的结论，补一章节');
    expect(compiled.semantics).toEqual([{ type: 'session', sessionId: 'ses_2' }]);
});

test('pasted @title references dedupe against canonical session tokens', () => {
    const compiled = compileChatComposerDelivery({
        plan: legacyTextToAuthoredPlan('merge @session:ses_2 and @Effect 和 Cordis 的 DI 对比 notes'),
        agents,
        installedSkillNames: new Set(),
        directory: '/project',
        root: '/project',
    });

    expect(compiled.semantics).toEqual([{ type: 'session', sessionId: 'ses_2' }]);
});

test('unrelated @words do not create session references', () => {
    const compiled = compileChatComposerDelivery({
        plan: legacyTextToAuthoredPlan('email the @team about @src/a.ts'),
        agents,
        installedSkillNames: new Set(),
        directory: '/project',
        root: '/project',
        confirmedFilePaths: ['src/a.ts'],
    });

    expect(compiled.semantics).toEqual([]);
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
        directory: '/Users/example/.config',
        root: '/Users/example/.config',
        confirmedFilePaths: ['opencode'],
        confirmedDirectoryPaths: ['opencode'],
    });

    expect(compiled.attachments).toHaveLength(1);
    expect(compiled.attachments[0]?.serverPath).toBe('/Users/example/.config/opencode');
    expect(compiled.attachments[0]?.mimeType).toBe('application/x-directory');
    expect(compiled.attachments[0]?.filename).toBe('opencode');
});

test('Windows absolute drive path is kept and never joined with project root', () => {
    const compiled = compileChatComposerDelivery({
        plan: legacyTextToAuthoredPlan('open @C:\\abs\\f.ts'),
        agents,
        installedSkillNames: new Set(),
        directory: 'C:\\project',
        root: 'C:\\project',
        confirmedFilePaths: ['C:\\abs\\f.ts'],
    });

    expect(compiled.attachments).toHaveLength(1);
    expect(compiled.attachments[0]?.serverPath).toBe('C:/abs/f.ts');
    expect(compiled.attachments[0]?.filename).toBe('f.ts');
    expect(compiled.attachments[0]?.dataUrl).toBe('file:///C:/abs/f.ts');
});

test('Windows drive root resolves relative mentions without double-joining', () => {
    const compiled = compileChatComposerDelivery({
        plan: legacyTextToAuthoredPlan('open @src\\a.ts'),
        agents,
        installedSkillNames: new Set(),
        directory: 'C:\\project',
        root: 'C:\\project',
        confirmedFilePaths: ['src\\a.ts'],
    });

    expect(compiled.attachments).toHaveLength(1);
    expect(compiled.attachments[0]?.serverPath).toBe('C:/project/src/a.ts');
    expect(compiled.attachments[0]?.filename).toBe('a.ts');
    expect(compiled.attachments[0]?.dataUrl).toBe('file:///C:/project/src/a.ts');
});

test('Windows bare drive root C:\\ joins relative mentions as C:/...', () => {
    const compiled = compileChatComposerDelivery({
        plan: legacyTextToAuthoredPlan('open @src\\a.ts'),
        agents,
        installedSkillNames: new Set(),
        directory: 'C:\\',
        root: 'C:\\',
        confirmedFilePaths: ['src\\a.ts'],
    });

    expect(compiled.attachments).toHaveLength(1);
    expect(compiled.attachments[0]?.serverPath).toBe('C:/src/a.ts');
    expect(compiled.attachments[0]?.filename).toBe('a.ts');
    expect(compiled.attachments[0]?.dataUrl).toBe('file:///C:/src/a.ts');
});

test('UNC absolute path is kept as //server/share form', () => {
    const compiled = compileChatComposerDelivery({
        plan: legacyTextToAuthoredPlan('open @\\\\server\\share\\f.ts'),
        agents,
        installedSkillNames: new Set(),
        directory: 'C:\\project',
        root: 'C:\\project',
        confirmedFilePaths: ['\\\\server\\share\\f.ts'],
    });

    expect(compiled.attachments).toHaveLength(1);
    expect(compiled.attachments[0]?.serverPath).toBe('//server/share/f.ts');
    expect(compiled.attachments[0]?.filename).toBe('f.ts');
    expect(compiled.attachments[0]?.dataUrl).toBe('file:////server/share/f.ts');
});

test('UNC root resolves relative mentions under the share', () => {
    const compiled = compileChatComposerDelivery({
        plan: legacyTextToAuthoredPlan('open @src\\a.ts'),
        agents,
        installedSkillNames: new Set(),
        directory: '\\\\server\\share',
        root: '\\\\server\\share',
        confirmedFilePaths: ['src\\a.ts'],
    });

    expect(compiled.attachments).toHaveLength(1);
    expect(compiled.attachments[0]?.serverPath).toBe('//server/share/src/a.ts');
    expect(compiled.attachments[0]?.filename).toBe('a.ts');
    expect(compiled.attachments[0]?.dataUrl).toBe('file:////server/share/src/a.ts');
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
