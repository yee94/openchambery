import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Nested session transcripts share MessageList with the primary chat. The
 * send-park latch stays primary-owned, but the empty tail under the newest
 * row must be the same breathing room — otherwise a live reasoning stream
 * grows against the panel edge and the follow writer jitters.
 */
describe('ContextPanelSessionTranscript tail occupancy', () => {
    const source = readFileSync(join(here, 'ContextPanelSessionTranscript.tsx'), 'utf8');
    const chatContainer = readFileSync(join(here, '../chat/ChatContainer.tsx'), 'utf8');

    test('uses the same desktop tail spacer as the primary transcript', () => {
        expect(source).toContain('CHAT_TAIL_SPACER_DESKTOP_HEIGHT');
        expect(source).toContain('footerSlot={legendTimelineEnabled ? tailSpacer : undefined}');
        expect(source).not.toContain('className="h-12"');
        expect(chatContainer).toContain('CHAT_TAIL_SPACER_DESKTOP_HEIGHT');
    });

    test('does not own the send-park latch', () => {
        expect(source).toContain('enableSendPark={false}');
    });

    test('legend path lets the list own the scroller and disables auto-follow', () => {
        expect(source).toContain('enabled: active && !legendTimelineEnabled');
        expect(source).toContain('timelineScrollClassName="absolute inset-0 z-0 chat-scroll overlay-scrollbar-target"');
        expect(source).toContain('timelineFollowEnabled={!legendFollowReleased}');
        expect(source).toContain('timelineHistoryAnchorToken={timelineHistoryAnchorToken}');
    });
});
