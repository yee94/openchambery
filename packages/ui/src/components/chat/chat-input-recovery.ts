import type { AttachedFile } from '@/stores/types/sessionTypes';

export const mergeFailedComposerText = (failedText: string, currentText: string): string => {
    if (!failedText) return currentText;
    if (!currentText || currentText === failedText) return failedText;
    return `${failedText}\n\n${currentText}`;
};

export const mergeFailedAttachments = (
    failedAttachments: AttachedFile[],
    currentAttachments: AttachedFile[],
): AttachedFile[] => {
    if (failedAttachments.length === 0) return currentAttachments;
    const failedIds = new Set(failedAttachments.map((file) => file.id));
    return [
        ...failedAttachments,
        ...currentAttachments.filter((file) => !failedIds.has(file.id)),
    ];
};

/**
 * Whether submit should trigger root attachment cleanup.
 * Only when non-queued, non-resource-preserving, and captured root attachments exist.
 */
export const shouldConsumeRootAttachmentsOnSubmit = (input: {
    queuedOnly: boolean;
    resourcePolicy: boolean;
    rootAttachmentCount: number;
}): boolean => !input.queuedOnly && !input.resourcePolicy && input.rootAttachmentCount > 0;
