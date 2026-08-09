import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainLayoutSource = readFileSync(
    join(__dirname, '..', 'MainLayout.tsx'),
    'utf-8',
);

describe('MainLayout mobile SessionSidebar mount (issue #1695 regression guard)', () => {
    test('mobile exclusive primaries do not keep ChatView as the sole primary content', () => {
        const mobileLayoutStart = mainLayoutSource.indexOf('{isMobile ? (');
        const desktopLayoutStart = mainLayoutSource.indexOf(') : (', mobileLayoutStart);
        const mobileLayoutSource = mainLayoutSource.slice(mobileLayoutStart, desktopLayoutStart);

        // Chat stays keep-alive under mountChatKeepAlive, but exclusive surfaces
        // (assistant/schedule/plan) mount as absolute overlays and hide chat.
        expect(mobileLayoutSource).toContain('{isAssistantActive && (');
        expect(mobileLayoutSource).toContain('{mountChatKeepAlive && (');
        expect(mobileLayoutSource).toContain('<ErrorBoundary><ChatView /></ErrorBoundary>');
        expect(mobileLayoutSource).toContain("!isChatActive && 'invisible'");
    });

    test('mobile SessionSidebar is always mounted but gated via isVisible prop', () => {
        const mobileSidebarIndex = mainLayoutSource.indexOf('<SessionSidebar');
        expect(mobileSidebarIndex).toBeGreaterThan(-1);
        const mobileBlock = mainLayoutSource.slice(mobileSidebarIndex, mobileSidebarIndex + 220);
        expect(mobileBlock).toContain('mobileVariant');
        expect(mobileBlock).toContain('isVisible={mobileLeftDrawerVisible}');

        const windowStart = Math.max(0, mobileSidebarIndex - 400);
        const precedingWindow = mainLayoutSource.slice(windowStart, mobileSidebarIndex);

        // Outer shell must stay mounted (issue #1695); do not gate the whole
        // component with mobileLeftDrawerVisible && (...).
        expect(/\{\s*mobileLeftDrawerVisible\s*&&\s*\(/.test(precedingWindow)).toBe(false);
        expect(precedingWindow.includes('pointer-events-none')).toBe(true);
    });

    test('desktop SessionSidebar is rendered inside Sidebar with isVisible={isSidebarOpen}', () => {
        const desktopSidebarIndex = mainLayoutSource.indexOf('<SessionSidebar isVisible={isSidebarOpen}');
        expect(desktopSidebarIndex).toBeGreaterThan(-1);

        const windowStart = Math.max(0, desktopSidebarIndex - 300);
        const precedingWindow = mainLayoutSource.slice(windowStart, desktopSidebarIndex);

        expect(precedingWindow).toContain('<Sidebar');
        expect(/mobileLeftDrawerVisible\s*&&/.test(precedingWindow)).toBe(false);
    });
});
