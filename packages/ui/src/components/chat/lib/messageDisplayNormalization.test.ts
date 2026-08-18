import { describe, expect, test } from 'bun:test'
import type { Part } from '@opencode-ai/sdk/v2'
import {
    getNormalizedMessageForDisplay,
    isCompactionCommandMessage,
    isCompactionCommandParts,
} from './messageDisplayNormalization'
import { buildMessageReferenceParts } from '@/lib/messages/references'
import { buildSessionMentionInstruction, parseSessionMentionInstruction } from '@/composer/delivery'
import { isSyntheticPart } from '@/lib/messages/synthetic'

function createText(id: string, text: string, synthetic?: boolean): Part {
    return {
        id,
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'text',
        text,
        ...(synthetic !== undefined ? { synthetic } : {}),
    } as Part
}

describe('isCompactionCommandParts', () => {
    test('detects raw compaction parts and exact /compact text', () => {
        expect(isCompactionCommandParts([{ type: 'compaction' }])).toBe(true)
        expect(isCompactionCommandParts([{ type: 'text', text: '/compact' }])).toBe(true)
        expect(isCompactionCommandParts([{ type: 'text', text: '  /compact  ' }])).toBe(true)
        expect(isCompactionCommandParts([{ type: 'text', text: '/compact please' }])).toBe(false)
        expect(isCompactionCommandParts([{ type: 'text', text: 'hello' }])).toBe(false)
        expect(isCompactionCommandParts(undefined)).toBe(false)
    })

    test('detects compaction from sourceParts when display parts are already normalized', () => {
        expect(isCompactionCommandMessage({
            info: { id: 'u1', role: 'user' } as never,
            parts: [{ type: 'text', text: '/compact' } as Part],
            sourceParts: [{ type: 'compaction' } as Part],
        })).toBe(true)
    })
})

describe('getNormalizedMessageForDisplay sourceParts', () => {
    test('keeps session-mention synthetics on sourceParts for decoration recovery', () => {
        const instruction = buildSessionMentionInstruction([{
            id: 'ses_1',
            title: 'MessageReferenceChip',
            directory: '/project',
            messages: [{ role: 'user', text: 'hello' }],
        }])!
        const normalized = getNormalizedMessageForDisplay({
            info: { id: 'msg_1', role: 'user' } as never,
            parts: [
                createText('1', '123 [image-1.png] @MessageReferenceChip 间距调整'),
                createText('2', instruction, true),
            ],
        })

        expect(normalized.parts.some(isSyntheticPart)).toBe(false)
        expect(normalized.sourceParts?.some(isSyntheticPart)).toBe(true)

        const sessionMentions = (normalized.sourceParts ?? [])
            .filter((part) => part.type === 'text' && isSyntheticPart(part))
            .flatMap((part) => parseSessionMentionInstruction((part as { text: string }).text))
            .map((context) => ({ sessionId: context.id, sessionLabel: context.title }))

        const parts = buildMessageReferenceParts('123 [image-1.png] @MessageReferenceChip 间距调整', {
            citationIcons: new Map([['image-1.png', 'image']]),
            sessionMentions,
        })
        expect(parts?.map((part) => (
            part.type === 'text' ? part.text : [part.decoration.kind, part.decoration.label, part.decoration.icon]
        ))).toEqual([
            '123 ',
            ['image', 'image-1.png', 'file-image'],
            ' ',
            ['session', 'MessageReferenceChip', 'chat-thread'],
            ' 间距调整',
        ])
    })
})
