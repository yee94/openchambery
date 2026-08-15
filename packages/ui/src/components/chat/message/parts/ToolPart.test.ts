import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    statusBarPopoverListClassName,
    statusBarPopoverRowClassName,
    todoListClassName,
    todoToolListClassName,
    todoToolScrollOptions,
} from '../../statusBarPopover';
import { readTaskTagSessionIdFromOutput } from './taskSessionIdParser';
import {
    getToolExpandedContentClassName,
    getToolScrollableSectionPaddingClassName,
    MOBILE_SHELL_CODE_LINE_HEIGHT,
    TOOL_EXPANDED_TIMELINE_CLASS_NAME,
} from './toolExpandedLayout';

const __dirname = dirname(fileURLToPath(import.meta.url));
const toolPartSource = readFileSync(join(__dirname, 'ToolPart.tsx'), 'utf-8');
const mobileAppSource = readFileSync(join(__dirname, '../../../../apps/MobileApp.tsx'), 'utf-8');
const mobileChangesSurfaceSource = readFileSync(join(__dirname, '../../../../apps/MobileChangesSurface.tsx'), 'utf-8');
const diffViewSource = readFileSync(join(__dirname, '../../../views/DiffView.tsx'), 'utf-8');
const contextPanelSource = readFileSync(join(__dirname, '../../../layout/ContextPanel.tsx'), 'utf-8');
const progressiveGroupSource = readFileSync(join(__dirname, 'ProgressiveGroup.tsx'), 'utf-8');
const toolPresentationSource = readFileSync(join(__dirname, 'toolPresentation.tsx'), 'utf-8');

describe('editing tool icon size', () => {
    test('keeps edit and write icons slightly smaller than the 14px tool row slot', () => {
        expect(toolPresentationSource).toContain("const editIconClass = 'h-[13px] w-[13px] flex-shrink-0'");
        expect(toolPresentationSource).toContain('<Icon name="pencil" className={editIconClass} />');
        expect(toolPresentationSource).toContain('<Icon name="file-edit" className={editIconClass} />');
    });
});

describe('mobile press feedback', () => {
    test('tool rows opt into soft press so full-width subagent/tool rows never use compact scale', () => {
        expect(toolPartSource).toContain('data-mobile-press-feedback="soft"');
        expect(progressiveGroupSource).toContain('data-mobile-press-feedback={isWholeRowNav ? \'soft\' : undefined}');
    });
});

describe('static navigation hit targets', () => {
    test('read/skill rows use whole-row activation like edit/write file navigation', () => {
        expect(progressiveGroupSource).toContain('const isWholeRowNav = Boolean(readFileEntry || skillEntry)');
        expect(progressiveGroupSource).toContain('role={isWholeRowNav ? \'button\' : undefined}');
        expect(progressiveGroupSource).toContain('handleWholeRowNavClick');
        expect(progressiveGroupSource).not.toContain('MinDurationShineText');
    });

    test('mobile read/skill routes through openFile gesture sheet like edit diffs', () => {
        expect(progressiveGroupSource).toContain('useMobileAppActions');
        expect(progressiveGroupSource).toContain('mobileActions.openFile({');
        expect(mobileAppSource).toContain('openFile: ({ path, targetLine }) => {');
        expect(mobileAppSource).toContain('MOBILE_DIRECT_FILE_WINDOW_ID');
        expect(mobileAppSource).toContain('directFilePreview');
        expect(mobileAppSource).toContain('hideFileHeader');
        // root-sync effect must preserve type:file so Read preview is not reset to browser root
        const filesSurfaceSource = readFileSync(join(__dirname, '../../../../apps/MobileFilesSurface.tsx'), 'utf-8');
        expect(filesSurfaceSource).toContain("if (current.type === 'file')");
        expect(filesSurfaceSource).toContain('initialFilePath');
    });

    test('mobile read image preview loads relay assets through runtimeFetch', () => {
        const filesSurfaceSource = readFileSync(join(__dirname, '../../../../apps/MobileFilesSurface.tsx'), 'utf-8');
        expect(filesSurfaceSource).toContain('isRelayModeActive()');
        expect(filesSurfaceSource).toContain("runtimeFetch('/api/fs/raw', { query: { path: imagePath } })");
        expect(filesSurfaceSource).toContain('URL.createObjectURL(blob)');
        expect(filesSurfaceSource).toContain('URL.revokeObjectURL(objectUrl)');
        expect(filesSurfaceSource).toContain('const imageSrc = relayImageKey ? relayImageSrc');
    });
});

describe('tool busy title chrome', () => {
    test('non-task tool titles stay immediate full opacity without shine busy state', () => {
        expect(toolPartSource).not.toContain('MinDurationShineText');
        expect(toolPartSource).toContain('taskBusy && \'animate-text-shimmer\'');
        expect(toolPartSource).toContain("normalizedPartTool === 'bash' && typeof effectiveTimeStart === 'number'");
    });
});

describe('readTaskTagSessionIdFromOutput', () => {
    test('parses task tags without state attributes', () => {
        expect(readTaskTagSessionIdFromOutput('<task id="ses_abc123">')).toBe('ses_abc123');
    });

    test('parses task tags with additional attributes', () => {
        expect(readTaskTagSessionIdFromOutput('<task id="ses_def456" state="completed">')).toBe('ses_def456');
    });
});

describe('shared todo list layout', () => {
    test('popover and tool lists share row boundaries while the tool scroll container owns overflow', () => {
        expect(statusBarPopoverListClassName).toContain(todoListClassName);
        expect(todoToolListClassName).toContain(todoListClassName);
        expect(statusBarPopoverRowClassName).toContain('px-2.5 py-1.5');
        expect(todoToolScrollOptions).toEqual({
            className: 'p-0 rounded-none',
            maxHeightClass: 'max-h-[46vh]',
            disableHorizontal: true,
        });
    });

    test('Todo ToolPart uses the compact shared list and scroll options', () => {
        expect(toolPartSource).toContain('{ listClassName: todoToolListClassName }');
        expect(toolPartSource).toContain('todoToolScrollOptions,');
        expect(toolPartSource).toContain("getToolExpandedContentClassName(isMobile, 'todo')");
    });
});

describe('shared expanded tool layout', () => {
    test('all mobile tool content uses the compact Todo boundary and scroll padding', () => {
        expect(TOOL_EXPANDED_TIMELINE_CLASS_NAME).toBe('relative ml-2 pl-3');
        expect(getToolExpandedContentClassName(true)).toBe('relative flex min-w-0 flex-col gap-2 py-2');
        expect(getToolExpandedContentClassName(true, 'todo')).toBe('relative flex min-w-0 flex-col gap-1 py-0.5');
        expect(getToolScrollableSectionPaddingClassName(true)).toBe('p-0');
    });

    test('desktop layout stays unchanged and mobile Shell uses compact rhythm', () => {
        expect(getToolExpandedContentClassName(false)).toBe('relative flex flex-col gap-2 pr-2 pb-2 pt-2 pl-4');
        expect(getToolScrollableSectionPaddingClassName(false)).toBe('p-2');
        expect(getToolExpandedContentClassName(true, 'default', true)).toContain('gap-1');
        expect(MOBILE_SHELL_CODE_LINE_HEIGHT).toBe('1.25rem');
    });
});

describe('apply_patch navigation', () => {
    test('routes dedicated mobile clicks to every exact tool patch with an owning-turn fallback', () => {
        const clickHandlerStart = toolPartSource.indexOf('const handleMainClick');
        const fileNavigationStart = toolPartSource.indexOf('let filePath: unknown;', clickHandlerStart);
        const fileNavigationEnd = toolPartSource.indexOf('if (!isFileNavTool)', fileNavigationStart);
        const fileNavigation = toolPartSource.slice(fileNavigationStart, fileNavigationEnd);

        expect(clickHandlerStart).toBeGreaterThan(-1);
        expect(fileNavigationStart).toBeGreaterThan(clickHandlerStart);
        expect(fileNavigation).toContain('mobileActions.openToolDiff({');
        expect(fileNavigation).toContain('getToolNavigationDiffEntries(');
        expect(fileNavigation).toContain('patches: toolPatches,');
        expect(fileNavigation).toContain("else if (normalizedPartTool === 'apply_patch')");
        expect(toolPartSource).toContain('mobileActions.openTurnDiff(messageId);');
        expect(mobileAppSource).toContain('const openTurnDiffSurface = useEvent((messageId?: string) => {');
        expect(mobileAppSource).toContain('setTurnDiffMessageId(messageId ?? null);');
        expect(mobileAppSource).toContain('openToolDiff: ({ diffPath, patches, targetLine }) => {');
        expect(mobileAppSource).toContain('openChangesSurface({ path: diffPath, staged: false, targetLine, toolPatches: patches });');
        expect(fileNavigation).toContain('mobileActions.openChanges({ diffPath: relativePath, staged: false, targetLine });');
        expect(fileNavigation.indexOf('mobileActions.openChanges')).toBeLessThan(fileNavigation.indexOf("navigateToDiff(relativePath, false, 'turn', targetLine)"));
    });

    test('uses normalized file metadata to target turn diffs and retains a turn fallback', () => {
        expect(toolPartSource).toContain("normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit' || normalizedPartTool === 'apply_patch'");
        expect(toolPartSource).toContain('getPrimaryToolPath(normalizedPartTool, input, metadata)');
        expect(toolPartSource).toContain('getPrimaryDiffFromMetadata(normalizedPartTool, metadata, filePath)');
        expect(toolPartSource).toContain('const fileDiff = metadata.filediff;');
        expect(toolPartSource).toContain('getPatchText((fileDiff as { patch?: unknown }).patch)');
        expect(toolPartSource).toContain('if (isFileNavTool && !currentDirectory)');
        expect(toolPartSource).toContain("openContextDiff(currentDirectory, relativePath, false, 'turn', targetLine, messageId);");
        expect(toolPartSource).toContain("openContextPanelTab(currentDirectory, { mode: 'diff', diffScope: 'turn', diffTurnMessageId: messageId });");
        expect(toolPartSource).toContain('openContextToolDiff(');
        expect(contextPanelSource).toContain('contextToolDiff?.targetPath === tab.targetPath');
        expect(contextPanelSource).toContain('toolPatches={toolPatches}');
        expect(contextPanelSource).toContain('stackedDefaultCollapsedAll={!toolPatches}');
        expect(diffViewSource).toContain('const activeTurnDiffs = React.useMemo<TurnSnapshotDiff[]>(');
        expect(diffViewSource).toContain('selectedToolTurnDiffs.length > 0 ? selectedToolTurnDiffs : lastTurnDiffs');
        expect(diffViewSource).toContain('stackedToolPatchesRef.current !== toolPatches');
    });

    test('keeps the owning assistant message id when memoized tool rows update', () => {
        expect(toolPartSource).toContain('&& prev.messageId === next.messageId');
        expect(progressiveGroupSource).toContain('&& prev.activity.messageId === next.activity.messageId');
    });

    test('presents every current-turn diff in a closable high motion sheet', () => {
        const turnDiffStart = mobileAppSource.indexOf('<MobileResizableSheet\n            id={MOBILE_TURN_DIFF_WINDOW_ID}');
        const turnDiffEnd = mobileAppSource.indexOf('{changesOpen && pendingChangesDiff ? (', turnDiffStart);
        const turnDiffPresentation = mobileAppSource.slice(turnDiffStart, turnDiffEnd);

        expect(turnDiffStart).toBeGreaterThan(-1);
        expect(turnDiffEnd).toBeGreaterThan(turnDiffStart);
        expect(turnDiffPresentation).toContain('<MobileResizableSheet');
        expect(turnDiffPresentation).toContain('open={turnDiffOpen}');
        expect(turnDiffPresentation).toContain('resizeAriaLabel={t(\'mobile.changes.sheet.resizeAria\')}');
        expect(turnDiffPresentation).toContain('initiallyExpanded');
        expect(turnDiffPresentation).toContain('<DiffView hideStackedFileSidebar diffScope="turn" turnMessageId={turnDiffMessageId} flushContent />');
        expect(mobileAppSource).toContain('|| turnDiffOpen');
        expect(mobileAppSource).toContain('if (turnDiffOpen) {');
        expect(diffViewSource).toContain("showFileActions={activeDiffScope !== 'turn'}");
        expect(diffViewSource).toContain('sessionMessages.findIndex((message) => message.id === turnMessageId)');
    });

    test('presents a direct mobile diff in the shared resizable sheet', () => {
        const directDiffStart = mobileAppSource.indexOf('{changesOpen && pendingChangesDiff ? (');
        const directDiffEnd = mobileAppSource.indexOf(') : changesOpen ? (', directDiffStart);
        const directDiffPresentation = mobileAppSource.slice(directDiffStart, directDiffEnd);

        expect(directDiffStart).toBeGreaterThan(-1);
        expect(directDiffEnd).toBeGreaterThan(directDiffStart);
        expect(directDiffPresentation).toContain('<MobileResizableSheet');
        expect(directDiffPresentation).toContain('resizeAriaLabel={t(\'mobile.changes.sheet.resizeAria\')}');
        expect(directDiffPresentation).toContain('initiallyExpanded');
        expect(directDiffPresentation).toContain('pendingChangesDiff.toolPatches?.length ? (');
        expect(directDiffPresentation).toContain('toolPatches={pendingChangesDiff.toolPatches}');
        expect(directDiffPresentation).toContain('singleFileView={pendingChangesDiff.toolPatches.length === 1}');
        expect(mobileAppSource).toContain(') : pendingChangesDiff?.toolPatches?.length ? (');
        expect(directDiffPresentation).toContain('hideDiffHeader');
        expect(mobileChangesSurfaceSource).toContain('hideHeader={hideDiffHeader}');
        expect(mobileChangesSurfaceSource).toContain('p-3 pwa-overlay-scroll');
    });
});

describe('context diff navigation', () => {
    test('replays same-target navigation requests when a context tab is reopened', () => {
        expect(contextPanelSource).toContain('navigationRequestKey={tab.touchedAt}');
        expect(contextPanelSource).toContain('turnMessageId={tab.diffTurnMessageId}');
        expect(diffViewSource).toContain('navigationRequestKey?: number;');
        expect(diffViewSource).toContain('[activeDiffScope, expandStackedFile, navigationRequestKey, targetFilePath, targetLine]');
    });
});
