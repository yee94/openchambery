import { describe, expect, test } from 'bun:test';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import {
    mergeFailedAttachments,
    mergeFailedComposerText,
    shouldConsumeRootAttachmentsOnSubmit,
} from './chat-input-recovery';

const attachment = (id: string): AttachedFile => ({
    id,
    file: new File([], `${id}.txt`, { type: 'text/plain' }),
    dataUrl: `data:text/plain;base64,${id}`,
    mimeType: 'text/plain',
    filename: `${id}.txt`,
    size: 0,
    source: 'local',
});

describe('chat input send failure recovery', () => {
    test('restores a failed message into an empty composer', () => {
        expect(mergeFailedComposerText('failed message', '')).toBe('failed message');
    });

    test('preserves text entered while the failed request was pending', () => {
        expect(mergeFailedComposerText('failed message', 'new draft')).toBe('failed message\n\nnew draft');
    });

    test('does not duplicate text already restored by another send layer', () => {
        expect(mergeFailedComposerText('failed message', 'failed message')).toBe('failed message');
    });

    test('restores failed attachments and preserves newly attached files', () => {
        const failed = attachment('failed');
        const current = attachment('current');
        expect(mergeFailedAttachments([failed], [failed, current])).toEqual([failed, current]);
    });

    test('submit consumes root attachments only when not queued/resource-preserving and count > 0', () => {
        expect(shouldConsumeRootAttachmentsOnSubmit({ queuedOnly: false, resourcePolicy: false, rootAttachmentCount: 1 })).toBe(true);
        expect(shouldConsumeRootAttachmentsOnSubmit({ queuedOnly: true, resourcePolicy: false, rootAttachmentCount: 1 })).toBe(false);
        expect(shouldConsumeRootAttachmentsOnSubmit({ queuedOnly: false, resourcePolicy: true, rootAttachmentCount: 1 })).toBe(false);
        expect(shouldConsumeRootAttachmentsOnSubmit({ queuedOnly: false, resourcePolicy: false, rootAttachmentCount: 0 })).toBe(false);
    });

});
