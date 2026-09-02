import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const progressiveGroupSource = readFileSync(join(__dirname, 'ProgressiveGroup.tsx'), 'utf-8');
const formatActivityDurationSource = readFileSync(join(__dirname, 'formatActivityDuration.ts'), 'utf-8');
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

    test('consecutive skills collapse into a Skill group; other static tools stay one-call rows; context tools collapse into Explored groups', () => {
        // consecutive 2+ skill calls collapse into one SkillToolGroup
        expect(progressiveGroupSource).toContain('if (isSkillGroupTool(toolName))');
        expect(progressiveGroupSource).toContain('collectConsecutiveSkillTools');
        expect(progressiveGroupSource).toContain("type: 'tool-skill-group'");
        expect(progressiveGroupSource).toContain('if (grouped.items.length > 0)');
        expect(progressiveGroupSource).toContain("case 'tool-skill-group':");
        expect(progressiveGroupSource).toContain('<SkillToolGroup');
        expect(messageBodySource).toContain('isSkillGroupTool');
        expect(messageBodySource).toContain('SkillToolGroup');
        expect(messageBodySource).toContain('collectConsecutiveSkillTools');
        // other non-context static tools: one call per tool-static-group row
        expect(progressiveGroupSource).toContain("rows.push({ type: 'tool-static-group', toolName, activities: [activity] });");
        // context tools (read/glob/grep/list): consecutive collapse via collectConsecutiveContextTools
        expect(progressiveGroupSource).toContain('if (isContextGroupTool(toolName))');
        expect(progressiveGroupSource).toContain('collectConsecutiveContextTools');
        expect(progressiveGroupSource).toContain("type: 'tool-context-group'");
        expect(progressiveGroupSource).toContain('hasContextExploreSuccessor');
        expect(progressiveGroupSource).toContain('hasFollowingOtherType');
        expect(progressiveGroupSource).toContain('case \'tool-context-group\':');
        expect(progressiveGroupSource).toContain('<ContextToolGroup');
        expect(progressiveGroupSource).toContain('isTurnLive={isActive}');
        expect(progressiveGroupSource).toContain('hasFollowingOtherType={row.hasFollowingOtherType}');
        // MessageBody flat path mirrors the same grouping
        expect(messageBodySource).toContain('isContextGroupTool');
        expect(messageBodySource).toContain('ContextToolGroup');
        expect(messageBodySource).toContain('hasContextExploreSuccessor');
        expect(messageBodySource).toContain('isTurnLive={effectiveStreamPhase !== \'completed\'}');
        expect(messageBodySource).toContain('hasFollowingOtherType={hasContextExploreSuccessor');
        // Do not revive multi-target chip merge
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
        expect(progressiveGroupSource).toContain('const shouldRenderRows = !showHeader || effectivelyExpanded || previewCount > 0;');
        expect(progressiveGroupSource).not.toContain('isLiveActivity');
        expect(progressiveGroupSource).not.toContain('stickyOpenPartsRef');
    });

    test('uses the S1 lattice orb while activity is live and the stack icon when settled', () => {
        expect(progressiveGroupSource).toContain('LatticeOrb');
        expect(progressiveGroupSource).toContain('isActive && !isCompaction');
        expect(progressiveGroupSource).toContain('isMobile={isMobile}');
        expect(progressiveGroupSource).toContain("activityIconName = isCompaction ? 'fold-vertical' : 'stack'");
    });

    test('static tool rows use the shared lifecycle and restore their mapped icon after settlement', () => {
        expect(progressiveGroupSource).toContain('const isActive = primaryActivity ? isToolPartActive(primaryActivity.part) : true;');
        expect(progressiveGroupSource).toContain("t('chat.assistantStatus.usingTool', { tool: displayName })");
        expect(progressiveGroupSource).toContain(') : icon}');
        expect(progressiveGroupSource).toContain("isMobile ? 'size-4' : 'size-3.5'");
        expect(progressiveGroupSource).toContain('isMobile={isMobile}');
    });

    test('keeps lifecycle-unknown tool parts visible from their first frame', () => {
        expect(messageBodySource).toContain('const isActiveTool = isToolPartActive;');
        expect(messageBodySource).toContain('const isToolFinalized = isToolPartSettled;');
        expect(messageBodySource).not.toContain('shouldShowTool');
    });

    test('localizes every activity state and exposes its expanded state', () => {
        expect(progressiveGroupSource).toContain("'chat.activity.active'");
        expect(progressiveGroupSource).toContain("'chat.activity.completedStatus'");
        expect(progressiveGroupSource).toContain("? t('chat.activity.title')");
        expect(progressiveGroupSource).toContain('aria-expanded={effectivelyExpanded}');
        expect(progressiveGroupSource).toContain("? t('chat.activity.collapseAria')");
        expect(progressiveGroupSource).toContain(": t('chat.activity.expandAria')}");

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
            expect(dictionarySource).toContain('chat.assistantStatus.compacting');
            expect(dictionarySource).toContain('chat.activity.agentsWorking');
            expect(dictionarySource).toContain('chat.activity.agentsInvolved');
            expect(dictionarySource).toContain('chat.contextGroup.exploring');
            expect(dictionarySource).toContain('chat.contextGroup.explored');
            expect(dictionarySource).toContain('chat.contextGroup.searchPlural');
            expect(dictionarySource).toContain('chat.contextGroup.readPlural');
            expect(dictionarySource).toContain('chat.contextGroup.listPlural');
            expect(dictionarySource).toContain('chat.skillGroup.expandAria');
            expect(dictionarySource).toContain('chat.skillGroup.collapseAria');
            expect(dictionarySource).toContain('chat.skillGroup.summaryOverflow');
        }
        const simplifiedChinese = readFileSync(join(messageDictionaryDirectory, 'zh-CN.ts'), 'utf-8');
        const traditionalChinese = readFileSync(join(messageDictionaryDirectory, 'zh-TW.ts'), 'utf-8');
        expect(simplifiedChinese).toContain("'chat.activity.title': '处理详情'");
        expect(simplifiedChinese).toContain("'chat.activity.active': '正在处理'");
        expect(simplifiedChinese).toContain("'chat.activity.compacting': '正在压缩'");
        expect(simplifiedChinese).toContain("'chat.assistantStatus.compacting': '正在压缩中'");
        expect(simplifiedChinese).toContain("'chat.activity.compactionCompleted': '已完成压缩'");
        expect(simplifiedChinese).toContain("'chat.activity.expandAria': '展开处理详情'");
        expect(simplifiedChinese).toContain("'chat.activity.collapseAria': '收起处理详情'");
        expect(simplifiedChinese).toContain("'chat.activity.completed': '已处理 {duration}'");
        expect(simplifiedChinese).toContain("'chat.activity.completedStatus': '已处理'");
        expect(simplifiedChinese).toContain("'chat.activity.agentsWorking': '{count} 个 Agent 处理中'");
        expect(simplifiedChinese).toContain("'chat.activity.agentsInvolved': '{count} 个 Agent 参与'");
        expect(simplifiedChinese).toContain("'chat.contextGroup.explored': '探索'");
        expect(simplifiedChinese).toContain("'chat.contextGroup.listPlural': '{count} 次列举'");
        expect(simplifiedChinese).toContain("'chat.skillGroup.summaryOverflow': '{names} 等{count}个'");
        expect(traditionalChinese).toContain("'chat.activity.title': '處理詳情'");
        expect(traditionalChinese).toContain("'chat.activity.compacting': '正在壓縮'");
        expect(traditionalChinese).toContain("'chat.assistantStatus.compacting': '正在壓縮中'");
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
        // Live elapsed is owned by WorkingPlaceholder only; activity header
        // shows duration after the turn settles (no in-flight ticker).
        expect(progressiveGroupSource).not.toContain('useDurationTickerNow');
        expect(progressiveGroupSource).not.toContain('tickerNow - startedAt');
        expect(progressiveGroupSource).not.toContain('activeDuration');
        expect(progressiveGroupSource).toContain('formatActivityDuration(durationMs)');
        expect(progressiveGroupSource).toContain("import { formatActivityDuration } from './formatActivityDuration'");
    });

    test('idle Processed chrome restores pb-8 after header demotion', () => {
        const chatMessageSource = readFileSync(join(__dirname, '../../ChatMessage.tsx'), 'utf-8');
        expect(chatMessageSource).toContain('shouldTightenWorkingBottomGap({');
        expect(chatMessageSource).toContain('headerCompletionDisposition: turnGroupingContext?.completionDisposition');
        expect(chatMessageSource).not.toContain('const tightenWorkingBottomGap = turnGroupingContext?.isWorking === true || isInActiveTurn;');
    });

    test('uses one full-width disclosure with identical title geometry in both states', () => {
        const activityStatusSource = progressiveGroupSource.slice(
            progressiveGroupSource.indexOf('const activityStatusLabel = completionDisposition === undefined'),
            progressiveGroupSource.indexOf('const taskAvatarSeeds'),
        );
        const ariaExpandedIndex = progressiveGroupSource.indexOf('aria-expanded={effectivelyExpanded}');
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
        expect(progressiveGroupSource).toContain('const activityDuration = !isActive');
        expect(activityHeaderSource).toContain('{activityStatusLabel}');
        expect(activityHeaderSource).toContain('className="typography-meta shrink-0 tabular-nums text-muted-foreground">{activityDuration}</span>');
        expect(activityHeaderSource.match(/typography-meta shrink-0 tabular-nums text-muted-foreground/g)).toHaveLength(1);
        expect(activityHeaderSource).not.toContain('{activeDuration}');
        expect(activityHeaderSource).not.toContain('{completedDuration}');
        expect(progressiveGroupSource).toContain("'group/tool flex w-full min-w-0 flex-nowrap items-center text-left'");
        expect(progressiveGroupSource).toContain("'inline-flex min-w-0 flex-1 items-center overflow-clip'");
        expect(progressiveGroupSource).toContain("'ml-auto inline-flex max-w-[min(14rem,55%)] shrink-0 items-center justify-end'");
        expect(progressiveGroupSource).toContain("isMobile && 'pr-0'");
        expect(progressiveGroupSource.match(/aria-expanded=\{effectivelyExpanded\}/g)).toHaveLength(1);
        expect(progressiveGroupSource).toContain("? t('chat.activity.collapseAria')");
        expect(progressiveGroupSource).toContain(": t('chat.activity.expandAria')}");
        expect(progressiveGroupSource).toContain("name={effectivelyExpanded ? 'arrow-down-s' : 'arrow-right-s'}");
        expect(progressiveGroupSource).not.toContain("displayedTaskAvatarSeeds.length === 0 && 'ml-auto'");
        expect(formatActivityDurationSource).toContain("return `${minutes}m ${seconds}s`;");
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
        expect(turnItemSource).toContain("const hideUserMessage = turn.activityPresentationKind === 'compaction'");
        expect(turnItemSource).toContain('{hideUserMessage ? null : stickyUserHeader ? (');
        expect(turnItemSource).toContain('{showCompactionStatus ? (');
        expect(turnItemSource).toContain('parts={[]}');
        expect(turnItemSource).toContain('activityPresentationKind="compaction"');
        expect(turnItemSource).toContain('completionDisposition={turn.completionDisposition}');
        expect(turnItemSource).toContain('durationMs={turn.durationMs}');
        expect(turnItemSource).toContain('onToggle={onToggleActivity}');
        expect(messageListSource).toContain('onToggleActivity={handleToggleTurnGroup}');
        expect(progressiveGroupSource).not.toContain('role="status"');
        expect(turnItemSource.indexOf('{showCompactionStatus ? (')).toBeLessThan(turnItemSource.indexOf('<TurnAssistantBlock'));
        expect(turnItemSource.indexOf('{pendingAssistantHeader ? (')).toBeLessThan(turnItemSource.indexOf('{showCompactionStatus ? ('));
        expect(turnItemSource).toContain('<MessageHeader');
        expect(messageListSource).toContain('pendingAssistantHeader={pendingAssistantHeader}');
        expect(messageListSource).toContain('hasActiveStreamingMessage: Boolean(activeStreamingMessageId)');
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
        expect(messageBodySource).toContain('pushActivityHeader(segment.id, visibleSegmentParts, segment.parts)');
        expect(progressiveGroupSource).toContain('// Header-only turns (e.g. completed compaction with foldable body text outside');
        expect(progressiveGroupSource).toContain('if ((!showHeader || (disclosureLockedOpen && !isCompaction)) && rows.length === 0)');
        expect(progressiveGroupSource).not.toContain('statusOnly');
    });

    test('hides live empty non-compaction activity headers until the first row exists', () => {
        expect(progressiveGroupSource).toContain('Live non-compaction with zero rows stays hidden');
        expect(progressiveGroupSource).toContain('if ((!showHeader || (disclosureLockedOpen && !isCompaction)) && rows.length === 0)');
    });

    test('shows expanded compaction summary body while still streaming (before stop)', () => {
        // Ordinary sorted turns defer non-final inline text into Activity; compaction
        // must paint the streaming summary under the open disclosure instead.
        expect(messageBodySource).toContain('&& !(isCompactionTurn && isActivityExpanded)');
        expect(messageBodySource).toContain('const shouldDeferSortedInlineText = isSortedRenderMode');
        expect(messageBodySource).toContain('canRevealSortedFinalBody');
        expect(messageBodySource).toContain('shouldStreamSortedFinalBody');
        expect(messageBodySource).not.toContain(
            'const shouldDeferSortedInlineText = isSortedRenderMode && !hasStopFinish;',
        );
    });

    test('keeps the pre-assistant compaction header expandable while details arrive', () => {
        expect(progressiveGroupSource).toContain('onClick={disclosureLockedOpen ? undefined : handleToggle}');
        expect(progressiveGroupSource).toContain('aria-expanded={effectivelyExpanded}');
        expect(progressiveGroupSource).toContain("? t('chat.activity.collapseAria')");
        expect(progressiveGroupSource).toContain(": t('chat.activity.expandAria')}");
        expect(progressiveGroupSource).toContain("name={effectivelyExpanded ? 'arrow-down-s' : 'arrow-right-s'}");
    });

    test('locks live activity open without indent rail or collapse control', () => {
        expect(progressiveGroupSource).toContain('const disclosureLockedOpen = isActive;');
        expect(progressiveGroupSource).toContain('const effectivelyExpanded = disclosureLockedOpen || isExpanded;');
        expect(progressiveGroupSource).toContain('if (disclosureLockedOpen) {\n            return;\n        }');
        expect(progressiveGroupSource).toContain("className={disclosureLockedOpen ? undefined : 'relative ml-2 pl-3'}");
        expect(progressiveGroupSource).toContain('{!disclosureLockedOpen ? (');
        expect(progressiveGroupSource).toContain('aria-disabled={disclosureLockedOpen || undefined}');
    });

    test('keeps task agent avatars and status-specific counts in active and completed headers', () => {
        expect(progressiveGroupSource).toContain('{displayedTaskAvatarSeeds.length > 0 ? (');
        expect(progressiveGroupSource).toContain('<AgentAvatar');
        expect(progressiveGroupSource).toContain('inline-flex shrink-0 items-center gap-0.5');
        expect(progressiveGroupSource).toContain('size-3.5 min-h-3.5 min-w-3.5 max-h-3.5 max-w-3.5');
        expect(progressiveGroupSource).toContain('flex-nowrap');
        expect(progressiveGroupSource).toContain('flex-1');
        expect(progressiveGroupSource).toContain('ml-auto');
        expect(progressiveGroupSource).toContain("'inline-flex flex-none items-center justify-center'");
        expect(progressiveGroupSource).toContain("isMobile ? 'h-5 w-4' : 'h-6 w-3.5'");
        expect(progressiveGroupSource).toContain("isMobile ? 'typography-meta h-5' : 'typography-ui-label h-5 font-semibold'");
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
        expect(progressiveGroupSource.match(/onClick=\{handleToggle\}/g)).toHaveLength(1);
        expect(progressiveGroupSource).toContain('onClick={disclosureLockedOpen ? undefined : handleToggle}');
    });

    test('materializes slim activity messages once when the user expands the disclosure', () => {
        expect(progressiveGroupSource).toContain("part.slim === true && (part.type === 'tool' || part.type === 'reasoning' || part.type === 'file')");
        expect(progressiveGroupSource).toContain('const materializationFlightsRef = React.useRef(new Map<string, Promise<void>>())');
        expect(progressiveGroupSource).toContain('if (materializationFlightsRef.current.has(targetMessageId)) continue;');
        expect(progressiveGroupSource).toContain('materializeTranscriptMessage(\n                effectiveDirectory,\n                targetSessionId,\n                targetMessageId,\n                { priority: autoSkipFailed ? \'background\' : \'user\' },\n            )');
        expect(progressiveGroupSource).toContain('if (!effectivelyExpanded) {\n            requestMaterialization();\n        }');
        expect(progressiveGroupSource).toContain("if (current.status === 'ready') continue;");
        expect(messageBodySource).toContain('materializationParts={materializationParts}');
        expect(messageBodySource).toContain('pushActivityHeader(segment.id, visibleSegmentParts, segment.parts)');
    });

    test('does not auto-materialize collapsed completed groups on mount', () => {
        // Jump-to-top virtualizer remounts hundreds of folded activity rows;
        // mount-time exact fill on every collapsed group recreated the 500+
        // session.message storm. Collapsed rows keep slim summaries; expand
        // (user priority) and already-expanded mount (background) still fill.
        expect(progressiveGroupSource).toContain('if (isActive || !effectivelyExpanded) {\n            return;\n        }\n        requestMaterialization(false, true);');
        expect(progressiveGroupSource).toMatch(/React\.useEffect\(\(\) => \{\n {8}if \(isActive \|\| !effectivelyExpanded\) \{\n {12}return;\n {8}\}\n {8}requestMaterialization\(false, true\);\n {4}\}, \[isActive, effectivelyExpanded\]\);/);
        expect(progressiveGroupSource).toContain("{ priority: autoSkipFailed ? 'background' : 'user' }");
    });

    test('background auto-fill never retries failed materializations', () => {
        // A host that keeps answering exact fetches with slim parts parks the
        // message in `error`; auto-retrying re-fires one fetch per virtualizer
        // remount (diagnostics trace: 104 materialize diffs in ~10s, slim/full
        // counts unchanged). Only manual expand / retry retry errors.
        expect(progressiveGroupSource).toContain('const requestMaterialization = useEvent((retryErrorsOnly = false, autoSkipFailed = false) => {');
        expect(progressiveGroupSource).toContain("if (autoSkipFailed && current.status === 'error') continue;");
        // User-driven expand keeps retrying transient errors.
        expect(progressiveGroupSource).toContain('if (!effectivelyExpanded) {\n            requestMaterialization();\n        }');
        expect(progressiveGroupSource).toContain('requestMaterialization(true)');
    });

    test('collapsed sorted body does not wrap empty or slim reasoning in tool-row padding', () => {
        // Slim reasoning has no text, so ReasoningPart returns null. Wrapping
        // that null in getToolRowBlockClass still paints py-1.5 per part and a
        // long turn (hundreds of slim traces) becomes a screen of blank space
        // between the Activity header and the final body. Expand/collapse
        // remounts after materialize and the gap disappears.
        expect(messageBodySource).toContain('if (part.type === \'reasoning\')');
        expect(messageBodySource).toContain('const activity = activityByPart.get(part);');
        expect(messageBodySource).toContain('if (activity?.kind === \'reasoning\')');
        expect(messageBodySource).toContain('if (!extractTextContent(part).trim())');
        expect(progressiveGroupSource).toContain("if (activity.kind === 'reasoning')");
        expect(progressiveGroupSource).toContain('if (!extractTextContent(activity.part).trim())');
    });

    test('sorted mode never treats a context-less assistant as the activity owner', () => {
        // A missing turnGroupingContext is a degenerate projection frame; the
        // owner fallback would inline every tool as flat rows and a multi-step
        // turn of such frames paints the intermittent huge gap. Mid-turn
        // assistants must fold away until a real context arrives.
        expect(messageBodySource).toContain('const isActivityOwnerMessage = !isSortedRenderMode');
        expect(messageBodySource).toContain(': (turnGroupingContext?.activityOwnerMessageId === messageId');
        expect(messageBodySource).toContain('if (isSortedRenderMode && !isActivityOwnerMessage) {');
    });

    test('shows localized loading, error, retry, and empty-output states only while expanded', () => {
        expect(progressiveGroupSource).toContain("requestedStatuses.includes('loading')");
        expect(progressiveGroupSource).toContain("requestedStatuses.includes('error')");
        expect(progressiveGroupSource).toContain("t('chat.activity.outputLoading')");
        expect(progressiveGroupSource).toContain("t('chat.activity.outputLoadFailed')");
        expect(progressiveGroupSource).toContain("t('chat.activity.outputRetry')");
        expect(progressiveGroupSource).toContain("t('chat.toolOutputDialog.noOutputProduced')");
        expect(progressiveGroupSource).toContain('effectivelyExpanded && (isMaterializationLoading || hasMaterializationError || showEmptyMaterialization)');
        expect(progressiveGroupSource).toContain('requestMaterialization(true)');

        for (const fileName of messageDictionaryFiles) {
            const dictionarySource = readFileSync(join(messageDictionaryDirectory, fileName), 'utf-8');
            expect(dictionarySource).toContain('chat.activity.outputLoading');
            expect(dictionarySource).toContain('chat.activity.outputLoadFailed');
            expect(dictionarySource).toContain('chat.activity.outputRetry');
        }
    });

    test('keeps non-slim activity messages on the existing render path', () => {
        expect(progressiveGroupSource).toContain('if (isSlimMaterializablePart(activity) && activity.messageId)');
        expect(progressiveGroupSource).toContain("part.slim === true");
        expect(progressiveGroupSource).not.toContain("part.type === 'text' || part.type === 'tool'");
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
        // File row passes the clicked path so mobile expands that file; header opens the whole turn.
        expect(messageBodySource).toContain('mobileActions.openTurnDiff(turnId, diffSessionId, file);');
        expect(messageBodySource).toContain('mobileActions.openTurnDiff(turnId, diffSessionId);');
        expect(messageBodySource).toContain("dedupeKey: `turn-diff:${diffSessionId || 'session'}:${turnId}`");
        expect(messageBodySource).toContain("diffScope: 'turn'");
        expect(messageBodySource).toContain('const diffSessionId = sessionSurface.sessionId;');
        expect(messageBodySource).toContain('fileCount={turnGroupingContext.diffStats.files}');
        expect(messageBodySource).toContain('isLatestTurn={turnGroupingContext.isLatestTurn}');
        expect(messageBodySource).toContain('&& !hasAuthoritativeChangesMarker');
    });

    test('turn changes preview uses a lightweight bordered card with tokenized interactive rows', () => {
        expect(messageBodySource).toContain('data-turn-changes-preview="true"');
        expect(messageBodySource).toContain('data-message-action-group="true"');
        expect(messageBodySource).toContain("const TURN_CHANGES_ROW_CLASS =");
        expect(messageBodySource).toContain("const TURN_CHANGES_ROW_DESKTOP_CLASS = 'h-7 gap-1.5';");
        expect(messageBodySource).toContain("const TURN_CHANGES_ROW_MOBILE_CLASS = 'h-6 gap-1';");
        expect(messageBodySource).toContain('mt-4 flex min-w-0 flex-col rounded-[var(--radius-lg)] border bg-muted/20');
        // L1 thin list renders per-file rows under the count header, no async list load.
        expect(messageBodySource).toContain('data-turn-change-file="true"');
        expect(messageBodySource).toContain('changedFiles={turnGroupingContext.changedFiles}');
        expect(messageBodySource).not.toContain('useSessionTurnChangesQuery');
        expect(messageBodySource).toContain('TURN_CHANGES_ROW_CLASS');
        expect(messageBodySource).toContain('TURN_CHANGES_ROW_DESKTOP_CLASS');
        expect(messageBodySource).toContain('TURN_CHANGES_ROW_MOBILE_CLASS');
        expect(messageBodySource).toContain("t('chat.changedFiles.title')");
        expect(messageBodySource).not.toContain('mt-4 rounded-xl border border-border/50 bg-muted/15 p-3');
        expect(messageBodySource).not.toContain('gap-1.5 sm:grid-cols-2');
        expect(messageBodySource).not.toContain('rounded-lg border border-border/30 bg-muted/30');
    });
});
