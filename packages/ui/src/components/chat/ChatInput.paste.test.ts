import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test, vi } from 'vitest';
import { collectFileDropReferences, normalizeFileDropPath } from './fileDropReferences';
import { assignImageAttachmentFilenames, buildAttachmentCitationText } from './attachmentCitations';
import { withReferenceInsertionBoundaries } from './insertionBoundaries';

// Execute the production paste callback with its composer boundary supplied by the harness.
const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ChatInput.tsx'), 'utf8');
const ast = ts.createSourceFile('ChatInput.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = '';
const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handlePaste'
        && node.initializer && ts.isCallExpression(node.initializer)) {
        callback = node.initializer.arguments[0].getText(ast);
    }
    ts.forEachChild(node, visit);
};
visit(ast);
if (!callback) throw new Error('Missing production paste handler');
const compiled = ts.transpileModule(`const handler = ${callback};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const paste = async ({ files = [], items = [], text = '', uri = '', nativePath = '' }: {
    files?: File[]; items?: File[]; text?: string; uri?: string; nativePath?: string;
}) => {
    const addAttachment = vi.fn().mockResolvedValue(undefined);
    const addDroppedPathsAsMentions = vi.fn();
    const insertTextAtSelection = vi.fn();
    const preventDefault = vi.fn();
    const scope = {
        collectFilePathsFromTransfer: (transfer: DataTransfer) => [...new Set([
            ...collectFileDropReferences(transfer).map(normalizeFileDropPath),
            ...(nativePath ? [nativePath] : []),
        ])],
        currentSessionId: 'session', newSessionDraftOpen: false, normalizeFileDropPath,
        addDroppedPathsAsMentions, inputMode: 'normal', textareaRef: { current: null },
        message: '', attachedFiles: [], pendingPastedAttachmentFilenamesRef: { current: new Set<string>() },
        getDocument: () => ({ text: '', references: [] }), canCompactPastedText: () => false,
        markFileMentionPasteSuppression: vi.fn(), assignImageAttachmentFilenames,
        buildAttachmentCitationText, withReferenceInsertionBoundaries,
        renameFileForAttachmentCitation: (file: File, filename: string) => new File([file], filename, { type: file.type }),
        insertTextAtSelection, getFileMentionInputSourceForInsertedText: () => 'paste',
        detachAttachmentsMissingCitations: vi.fn(), surfaceResources: { addAttachment },
    };
    const handler = new Function(...Object.keys(scope), `${compiled}\nreturn handler;`)(...Object.values(scope));
    await handler({ preventDefault, clipboardData: {
        files,
        items: items.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
        getData: (type: string) => type === 'text/uri-list' ? uri : ['text', 'text/plain'].includes(type) ? text : '',
    } });
    return { addAttachment, addDroppedPathsAsMentions, insertTextAtSelection, preventDefault };
};

const image = (type = 'image/png') => new File(['image bytes'], 'image.png', { type });

describe('ChatInput clipboard image precedence', () => {
    test('attaches image bytes instead of the accompanying Raycast file URI/path', async () => {
        const result = await paste({ files: [image()], text: '/tmp/raycast/image.png', uri: 'file:///tmp/raycast/image.png' });
        expect(result.addAttachment).toHaveBeenCalledTimes(1);
        expect(result.addAttachment.mock.calls[0][0].type).toBe('image/png');
        expect(result.addDroppedPathsAsMentions).not.toHaveBeenCalled();
        expect(result.insertTextAtSelection.mock.calls[0][0]).not.toContain('/tmp/raycast');
        expect(result.preventDefault).toHaveBeenCalled();
    });

    test('prefers an image over its Electron native path', async () => {
        const result = await paste({ files: [image()], nativePath: '/tmp/raycast/image.png' });
        expect(result.addAttachment).toHaveBeenCalledTimes(1);
        expect(result.addDroppedPathsAsMentions).not.toHaveBeenCalled();
    });

    test('uses one preferred item representation when files are unavailable', async () => {
        const result = await paste({ items: [image('image/tiff'), image()], uri: 'file:///tmp/image.png' });
        expect(result.addAttachment).toHaveBeenCalledTimes(1);
        expect(result.addAttachment.mock.calls[0][0].type).toBe('image/png');
    });

    test('does not duplicate files also exposed as items', async () => {
        const result = await paste({ files: [image()], items: [image(), image('image/tiff')] });
        expect(result.addAttachment).toHaveBeenCalledTimes(1);
    });

    test('keeps accompanying prose with the image', async () => {
        const result = await paste({ files: [image()], text: 'Please inspect this screenshot' });
        expect(result.addAttachment).toHaveBeenCalledTimes(1);
        expect(result.insertTextAtSelection.mock.calls[0][0]).toContain('Please inspect this screenshot');
    });

    test('preserves path-only paste when there are no image bytes', async () => {
        const result = await paste({ text: '/tmp/notes.txt' });
        expect(result.addDroppedPathsAsMentions).toHaveBeenCalledWith(['/tmp/notes.txt']);
        expect(result.addAttachment).not.toHaveBeenCalled();
    });
});
