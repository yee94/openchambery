import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const progressiveGroupSource = readFileSync(join(__dirname, 'ProgressiveGroup.tsx'), 'utf-8');
const messageBodySource = readFileSync(join(__dirname, '../MessageBody.tsx'), 'utf-8');
const messageListSource = readFileSync(join(__dirname, '../../MessageList.tsx'), 'utf-8');
const turnItemSource = readFileSync(join(__dirname, '../../components/TurnItem.tsx'), 'utf-8');
const messageDictionaryDirectory = join(__dirname, '../../../../lib/i18n/messages');
const messageDictionaryFiles = ['en.ts', 'es.ts', 'fr.ts', 'ja.ts', 'ko.ts', 'pl.ts', 'pt-BR.ts', 'uk.ts', 'zh-CN.ts', 'zh-TW.ts'];

describe('progressive activity presentation', () => {
    test('tool rows render without entrance or tail animation', () => {
        expect(progressiveGroupSource).not.toContain('ToolRevealOnMount');
        expect(progressiveGroupSource).not.toContain('FadeInOnReveal');
        expect(progressiveGroupSource).toContain('animateTailText={false}');
    });

    test('renders each static tool call as its own row without consecutive merge', () => {
        expect(progressiveGroupSource).toContain("rows.push({ type: 'tool-static-group', toolName, activities: [activity] });");
        expect(progressiveGroupSource).not.toContain('const activities = [activity];');
        expect(progressiveGroupSource).not.toContain('if (nextToolName !== toolName || !isStaticTool(nextToolName))');
        expect(progressiveGroupSource).not.toContain('i = nextIndex;');
        expect(progressiveGroupSource).not.toContain('const visibleReadFileEntries = readFileEntries.slice(0, 3);');
        expect(progressiveGroupSource).not.toContain('+{hiddenReadFileCount}');
        expect(progressiveGroupSource).not.toContain('+{hiddenDescriptionCount}');
        expect(progressiveGroupSource).not.toContain('+{hiddenSkillCount}');
    });

    test('every collapsed activity state hides all detail rows', () => {
        expect(messageBodySource).toContain('const collapsedPreviewCount = 0;');
        expect(messageBodySource).not.toContain('collapsedPreviewCount = completionDisposition');
    });

    test('row mounting depends only on the disclosure, never on turn disposition', () => {
        // Deriving mount state from disposition or streamPhase leaked live behavior
        // into settled turns (an aborted turn never left the live branch) and made a
        // one-frame disposition flap unmount every nested row. Structural stability
        // is owned by the data layer instead: see sync/displayParts.ts.
        expect(progressiveGroupSource).toContain('const shouldRenderRows = !showHeader || isExpanded || previewCount > 0;');
        expect(progressiveGroupSource).not.toContain('isLiveActivity');
        expect(progressiveGroupSource).not.toContain('stickyOpenPartsRef');
    });

    test('localizes every activity state and exposes its expanded state', () => {
        expect(progressiveGroupSource).toContain("'chat.activity.active'");
        expect(progressiveGroupSource).toContain("'chat.activity.completedStatus'");
        expect(progressiveGroupSource).toContain("? t('chat.activity.title')");
        expect(progressiveGroupSource).toContain('aria-expanded={isExpanded}');
        expect(progressiveGroupSource).toContain("aria-label={isExpanded ? t('chat.activity.collapseAria') : t('chat.activity.expandAria')}");

        for (const fileName of messageDictionaryFiles) {
            const dictionarySource = readFileSync(join(messageDictionaryDirectory, fileName), 'utf-8');
            expect(dictionarySource).toContain('chat.activity.title');
            expect(dictionarySource).toContain('chat.activity.expandAria');
            expect(dictionarySource).toContain('chat.activity.collapseAria');
            expect(dictionarySource).toContain('chat.activity.completed');
            expect(dictionarySource).toContain('chat.activity.completedStatus');
            expect(dictionarySource).toContain('chat.activity.active');
            expect(dictionarySource).toContain('chat.activity.compacting');
            expect(dictionarySource).toContain('chat.activity.compactionCompleted');
            expect(dictionarySource).toContain('chat.activity.agentsWorking');
            expect(dictionarySource).toContain('chat.activity.agentsInvolved');
        }
        const simplifiedChinese = readFileSync(join(messageDictionaryDirectory, 'zh-CN.ts'), 'utf-8');
        const traditionalChinese = readFileSync(join(messageDictionaryDirectory, 'zh-TW.ts'), 'utf-8');
        expect(simplifiedChinese).toContain("'chat.activity.title': '处理详情'");
        expect(simplifiedChinese).toContain("'chat.activity.active': '正在处理'");
        expect(simplifiedChinese).toContain("'chat.activity.compacting': '正在压缩'");
        expect(simplifiedChinese).toContain("'chat.activity.compactionCompleted': '已完成压缩'");
        expect(simplifiedChinese).toContain("'chat.activity.expandAria': '展开处理详情'");
        expect(simplifiedChinese).toContain("'chat.activity.collapseAria': '收起处理详情'");
        expect(simplifiedChinese).toContain("'chat.activity.completed': '已处理 {duration}'");
        expect(simplifiedChinese).toContain("'chat.activity.completedStatus': '已处理'");
        expect(simplifiedChinese).toContain("'chat.activity.agentsWorking': '{count} 个 agent 处理中'");
        expect(simplifiedChinese).toContain("'chat.activity.agentsInvolved': '{count} 个 agent 参与'");
        expect(traditionalChinese).toContain("'chat.activity.title': '處理詳情'");
        expect(traditionalChinese).toContain("'chat.activity.compacting': '正在壓縮'");
        expect(traditionalChinese).toContain("'chat.activity.compactionCompleted': '已完成壓縮'");
        expect(traditionalChinese).toContain("'chat.activity.expandAria': '展開處理詳情'");
        expect(traditionalChinese).toContain("'chat.activity.collapseAria': '收起處理詳情'");
        expect(traditionalChinese).toContain("'chat.activity.completedStatus': '已處理'");
    });

    test('uses turn-owned expansion and duration for the turn activity', () => {
        expect(messageListSource).toContain('durationMs: turn.durationMs');
        expect(messageListSource).toContain('resolveTurnActivityPresentation({');
        expect(messageListSource).toContain('completionDisposition: activityPresentation.completionDisposition');
        expect(messageListSource).toContain('durationMs: activityPresentation.durationMs');
        expect(messageListSource).toContain('isGroupExpanded: activityExpanded,');
        expect(messageListSource).not.toContain('(isLastTurn && sessionIsWorking) || isGroupExpanded');
        expect(messageBodySource).toContain('durationMs={turnGroupingContext.durationMs}');
        expect(messageBodySource).toContain('startedAt={turnGroupingContext.userMessageCreatedAt}');
        expect(messageBodySource).toContain('const durationMs = turnGroupingContext?.durationMs;');
        expect(messageBodySource).not.toContain('formatTurnDuration(messageCompletedAt - userCreatedAt)');
        expect(progressiveGroupSource).toContain('useDurationTickerNow(isActive, 250)');
        expect(progressiveGroupSource).toContain('tickerNow - startedAt');
        expect(progressiveGroupSource).toContain('formatActivityDuration(durationMs)');
    });

    test('uses one full-width disclosure with identical title geometry in both states', () => {
        const activityStatusSource = progressiveGroupSource.slice(
            progressiveGroupSource.indexOf('const activityStatusLabel = completionDisposition === undefined'),
            progressiveGroupSource.indexOf('const activityDuration'),
        );
        const ariaExpandedIndex = progressiveGroupSource.indexOf('aria-expanded={isExpanded}');
        const activityHeaderSource = progressiveGroupSource.slice(
            progressiveGroupSource.lastIndexOf('<button', ariaExpandedIndex),
            progressiveGroupSource.indexOf('</button>', ariaExpandedIndex),
        );
        expect(progressiveGroupSource).toContain("completionDisposition === 'normal' || completionDisposition === 'abnormal'");
        expect(progressiveGroupSource).not.toContain('if (!isActive && !isExpanded && completedDuration)');
        expect(activityStatusSource).toContain("completionDisposition === undefined");
        expect(activityStatusSource).toContain("? t(isCompaction ? 'chat.activity.compacting' : 'chat.activity.active')");
        expect(activityStatusSource).toContain("? t(isCompaction ? 'chat.activity.compactionCompleted' : 'chat.activity.completedStatus')");
        expect(activityStatusSource).not.toContain('isExpanded');
        expect(activityStatusSource).not.toContain("t('chat.activity.completed', { duration: completedDuration })");
        expect(progressiveGroupSource).toContain('const activityDuration = isActive ? activeDuration : completedDuration;');
        expect(activityHeaderSource).toContain('{activityStatusLabel}');
        expect(activityHeaderSource).toContain('className="typography-meta shrink-0 tabular-nums text-muted-foreground">{activityDuration}</span>');
        expect(activityHeaderSource.match(/typography-meta shrink-0 tabular-nums text-muted-foreground/g)).toHaveLength(1);
        expect(activityHeaderSource).not.toContain('{activeDuration}');
        expect(activityHeaderSource).not.toContain('{completedDuration}');
        expect(progressiveGroupSource).toContain("'group/tool flex w-full min-w-0 flex-nowrap items-center text-left'");
        expect(progressiveGroupSource).toContain("'inline-flex min-w-0 flex-1 items-center overflow-hidden'");
        expect(progressiveGroupSource).toContain("'ml-auto inline-flex max-w-[min(14rem,55%)] shrink-0 items-center justify-end'");
        expect(progressiveGroupSource).toContain("isMobile && 'pr-0'");
        expect(progressiveGroupSource.match(/aria-expanded=\{isExpanded\}/g)).toHaveLength(1);
        expect(progressiveGroupSource).toContain("aria-label={isExpanded ? t('chat.activity.collapseAria') : t('chat.activity.expandAria')}");
        expect(progressiveGroupSource).toContain("name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'}");
        expect(progressiveGroupSource).not.toContain("displayedTaskAvatarSeeds.length === 0 && 'ml-auto'");
        expect(progressiveGroupSource).toContain("return `${minutes}m ${seconds}s`;");
    });

    test('shimmers only the active title with the info status token', () => {
        expect(progressiveGroupSource).toContain("? 'animate-text-shimmer text-[var(--status-info)] [--oc-text-shimmer-base:var(--status-info)]'");
        expect(progressiveGroupSource).toContain(": 'text-foreground/85'");
        expect(progressiveGroupSource).toContain('className="typography-meta shrink-0 tabular-nums text-muted-foreground">{activityDuration}</span>');
    });

    test('shows compaction status from the turn before assistant activity exists', () => {
        expect(messageListSource).toContain('showCompactionStatus={shouldShowCompactionStatus({');
        expect(messageListSource).toContain('export const shouldShowCompactionStatus = (input: {');
        expect(messageListSource).toContain("if (input.chatRenderMode !== 'sorted')");
        expect(messageListSource).toContain("if (input.activityPresentationKind !== 'compaction')");
        expect(messageListSource).toContain('if (input.hasVisibleActivitySegments)');
        expect(messageListSource).toContain('if (input.hasAssistantMessages)');
        expect(messageListSource).toContain("input.completionDisposition === 'normal' || input.completionDisposition === 'abnormal'");
        expect(messageListSource).toContain("if (input.completionDisposition === 'active')");
        expect(messageListSource).toContain('return input.isLastTurn && input.sessionIsWorking;');
        expect(turnItemSource).toContain('{showCompactionStatus ? (');
        expect(turnItemSource).toContain('parts={[]}');
        expect(turnItemSource).toContain('activityPresentationKind="compaction"');
        expect(turnItemSource).toContain('completionDisposition={turn.completionDisposition}');
        expect(turnItemSource).toContain('durationMs={turn.durationMs}');
        expect(turnItemSource).toContain('onToggle={onToggleActivity}');
        expect(messageListSource).toContain('onToggleActivity={handleToggleTurnGroup}');
        expect(progressiveGroupSource).not.toContain('role="status"');
        expect(turnItemSource.indexOf('{showCompactionStatus ? (')).toBeLessThan(turnItemSource.indexOf('<TurnAssistantBlock'));
    });

    test('keeps live and ordinary turns on their established activity path', () => {
        const fallbackCondition = messageListSource.slice(
            messageListSource.indexOf('showCompactionStatus={shouldShowCompactionStatus({'),
            messageListSource.indexOf('stickyUserHeader={stickyUserHeader}'),
        );
        expect(fallbackCondition).toContain('chatRenderMode,');
        expect(fallbackCondition).toContain('activityPresentationKind: turn.activityPresentationKind,');
        expect(fallbackCondition).toContain('hasVisibleActivitySegments: visibleActivitySegments.length > 0,');
        expect(fallbackCondition).toContain('hasAssistantMessages: turn.assistantMessages.length > 0,');
        expect(fallbackCondition).toContain('completionDisposition: turn.completionDisposition,');
        expect(fallbackCondition).toContain('isLastTurn,');
        expect(fallbackCondition).toContain('sessionIsWorking,');
        expect(messageBodySource).toContain('activityPresentationKind={turnGroupingContext.activityPresentationKind}');
        expect(messageBodySource).toContain("const isCompactionTurn = turnGroupingContext?.activityPresentationKind === 'compaction'");
        expect(messageBodySource).toContain('const hideCompactionBody = isSortedRenderMode && isCompactionTurn && !isActivityExpanded');
        expect(messageBodySource).toContain('&& (hasAnchoredActivitySegments || isCompactionTurn)');
        expect(progressiveGroupSource).toContain("const isCompaction = activityPresentationKind === 'compaction';");
        expect(progressiveGroupSource).toContain("const activityIconName = isCompaction ? 'fold-vertical' : 'stack'");
    });

    test('folds compaction summary body under the disclosure in collapsed mode', () => {
        expect(messageBodySource).toContain('if (hideCompactionBody)');
        expect(messageBodySource).toContain('&& !hideCompactionBody');
        expect(messageBodySource).toContain('pushActivityHeader(`${messageId}:compaction-status`, [])');
        // Empty filtered segment parts still push the Activity chrome (no early
        // return) so mid-reconcile cannot unmount the live disclosure.
        expect(messageBodySource).toContain('pushActivityHeader(segment.id, visibleSegmentParts)');
        expect(progressiveGroupSource).toContain('// Header-only turns (e.g. completed compaction with foldable body text outside');
        expect(progressiveGroupSource).toContain('if (!showHeader && rows.length === 0)');
        expect(progressiveGroupSource).not.toContain('statusOnly');
    });

    test('shows expanded compaction summary body while still streaming (before stop)', () => {
        // Ordinary sorted turns defer non-stop inline text into Activity; compaction
        // must paint the streaming summary under the open disclosure instead.
        expect(messageBodySource).toContain('&& !(isCompactionTurn && isActivityExpanded)');
        expect(messageBodySource).toContain('const shouldDeferSortedInlineText = isSortedRenderMode');
        expect(messageBodySource).not.toContain(
            'const shouldDeferSortedInlineText = isSortedRenderMode && !hasStopFinish;',
        );
    });

    test('keeps the pre-assistant compaction header expandable while details arrive', () => {
        expect(progressiveGroupSource).toContain('onClick={handleToggle}');
        expect(progressiveGroupSource).toContain('aria-expanded={isExpanded}');
        expect(progressiveGroupSource).toContain("aria-label={isExpanded ? t('chat.activity.collapseAria') : t('chat.activity.expandAria')}");
        expect(progressiveGroupSource).toContain("name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'}");
    });

    test('keeps task agent avatars and status-specific counts in active and completed headers', () => {
        expect(progressiveGroupSource).toContain('{displayedTaskAvatarSeeds.length > 0 ? (');
        expect(progressiveGroupSource).toContain('<AgentAvatar');
        expect(progressiveGroupSource).toContain('inline-flex shrink-0 items-center gap-0.5');
        expect(progressiveGroupSource).toContain('size-3.5 min-h-3.5 min-w-3.5 max-h-3.5 max-w-3.5');
        expect(progressiveGroupSource).toContain('flex-nowrap');
        expect(progressiveGroupSource).toContain('flex-1');
        expect(progressiveGroupSource).toContain('ml-auto');
        expect(progressiveGroupSource).toContain("isMobile ? 'typography-meta h-4' : 'typography-ui-label h-5 font-semibold'");
        expect(progressiveGroupSource).toContain('displayedTaskAvatarSeeds.slice(0, isMobile ? 2 : 3)');
        // Status/duration left (flex-1), agents+chevron trailer right (ml-auto).
        // Mobile pr-0 flushes chevron; desktop keeps chip px-2 for symmetric hover wash.
        expect(progressiveGroupSource).toContain("isMobile && 'pr-0'");
        expect(progressiveGroupSource).toContain("'ml-auto inline-flex max-w-[min(14rem,55%)] shrink-0 items-center justify-end'");
        expect(progressiveGroupSource).toContain("isMobile && '-mr-0.5'");
        expect(progressiveGroupSource).not.toContain('ring-foreground');
        expect(progressiveGroupSource).toContain("t('chat.activity.agentsWorking', { count: displayedTaskAvatarSeeds.length })");
        expect(progressiveGroupSource).toContain("t('chat.activity.agentsInvolved', { count: displayedTaskAvatarSeeds.length })");
    });

    test('keeps the disclosure header under the pointer while its rows resize', () => {
        expect(progressiveGroupSource).toContain('ref={activityHeaderRef}');
        expect(progressiveGroupSource).toContain('top: header.getBoundingClientRect().top');
        expect(progressiveGroupSource).toContain("header.closest<HTMLElement>('[data-scrollbar=\"chat\"]')");
        expect(progressiveGroupSource).toContain('anchor.scrollContainer.scrollTop += delta');
        expect(progressiveGroupSource).toContain('window.requestAnimationFrame(() => {');
        expect(progressiveGroupSource.match(/onClick=\{handleToggle\}/g)).toHaveLength(2);
    });

    test('keeps standalone task tools in chronological activity rows', () => {
        expect(progressiveGroupSource).toContain('if (isStandaloneTool(toolName))');
        expect(progressiveGroupSource).toContain("rows.push({ type: 'tool-expandable', activity });");
        expect(progressiveGroupSource).not.toContain('Standalone tools are rendered separately, skip');
    });

    test('suppresses every sorted tool already projected into activity', () => {
        expect(messageBodySource).toContain("if (activity?.kind === 'tool')");
        expect(messageBodySource).not.toContain("activity?.kind === 'tool' && !isStandaloneTool(toolName)");
        expect(messageBodySource).toContain('if (!isSortedRenderMode || !all)');
    });

    test('summarizes active task agents while retaining every completed participant', () => {
        expect(progressiveGroupSource).toContain("part.tool?.trim().toLowerCase() !== 'task'");
        expect(progressiveGroupSource).toContain("stateRecord.status === 'pending' || stateRecord.status === 'running'");
        expect(progressiveGroupSource).toContain('const taskId = typeof part.id === \'string\' ? part.id.trim() : \'\'');
        expect(progressiveGroupSource).toContain('return { active, all };');
        expect(progressiveGroupSource).toContain('const displayedTaskAvatarSeeds = isActive ? taskAvatarSeeds.active : taskAvatarSeeds.all;');
        expect(progressiveGroupSource).toContain('displayedTaskAvatarSeeds.slice(0, isMobile ? 2 : 3)');
        expect(progressiveGroupSource).toContain('<AgentAvatar');
        expect(progressiveGroupSource).not.toContain('hiddenTaskAgentCount');
        expect(progressiveGroupSource).toContain('count: displayedTaskAvatarSeeds.length');
    });

    test('turn changes preview carries historical turn identity across desktop and dedicated mobile', () => {
        expect(messageBodySource).toContain('mobileActions.openTurnDiff(turnId);');
        expect(messageBodySource).toContain("openContextDiff(effectiveDirectory, file, false, 'turn', undefined, turnId);");
        expect(messageBodySource).toContain('const visibleFiles = files.slice(0, 5);');
        expect(messageBodySource).toContain('&& !hasAuthoritativeChangedFiles');
    });

    test('turn changes preview uses a lightweight bordered card with tokenized interactive rows', () => {
        expect(messageBodySource).toContain('data-turn-changes-preview="true"');
        expect(messageBodySource).toContain('data-message-action-group="true"');
        expect(messageBodySource).toContain("const TURN_CHANGES_ROW_CLASS =");
        expect(messageBodySource).toContain("const TURN_CHANGES_ROW_DESKTOP_CLASS = 'h-7 gap-1.5';");
        expect(messageBodySource).toContain("const TURN_CHANGES_ROW_MOBILE_CLASS = 'h-6 gap-1';");
        expect(messageBodySource).toContain('mt-4 flex min-w-0 flex-col rounded-[var(--radius-lg)] border bg-muted/20');
        expect(messageBodySource).toContain('data-turn-change-file="true"');
        expect(messageBodySource).toContain('TURN_CHANGES_ROW_CLASS');
        expect(messageBodySource).toContain('TURN_CHANGES_ROW_DESKTOP_CLASS');
        expect(messageBodySource).toContain('TURN_CHANGES_ROW_MOBILE_CLASS');
        expect(messageBodySource).toContain('min-w-0 flex-1 truncate text-left');
        expect(messageBodySource).not.toContain('mt-4 rounded-xl border border-border/50 bg-muted/15 p-3');
        expect(messageBodySource).not.toContain('gap-1.5 sm:grid-cols-2');
        expect(messageBodySource).not.toContain('rounded-lg border border-border/30 bg-muted/30');
    });
});
