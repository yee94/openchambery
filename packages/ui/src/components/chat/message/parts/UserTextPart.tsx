import React from 'react';
import { cn } from '@/lib/utils';
import type { Part } from '@opencode-ai/sdk/v2';
import type { AgentMentionInfo } from '../types';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { useUIStore } from '@/stores/useUIStore';
import { useInstalledSkillsQuery } from '@/queries/installedSkillsQueries';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from '@/components/icon/icons';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getDirectoryForFilePath } from '@/lib/path-utils';
import { useI18n } from '@/lib/i18n';
import {
    type ComposerTriggerIconSpec,
} from '@/composer/inline-visual';
import {
    buildAgentMentionUrl,
    parseSkillHref,
} from '@/lib/messages/inlineMessageLinks';
import {
    buildCitationIconsFromParts,
    buildMessageReferenceParts,
    type MessageReferenceDecoration,
    type MessageTextPart,
} from '@/lib/messages/references';
import { prepareUserMarkdownContent, SKILL_TOKEN_PATTERN } from './userTextPartContent';

type PartWithText = Part & { text?: string; content?: string; value?: string };

type UserTextPartProps = {
    part: Part;
    messageId: string;
    isMobile: boolean;
    agentMention?: AgentMentionInfo;
    /** Sibling parts on the same user message — used for image/selection citation icons. */
    messageParts?: readonly Part[];
};

const hasPotentialSkillToken = (textContent: string): boolean => {
    SKILL_TOKEN_PATTERN.lastIndex = 0;
    return SKILL_TOKEN_PATTERN.test(textContent) || textContent.includes('[skill:');
};

const normalizeUserMessageRenderingMode = (mode: unknown): 'markdown' | 'plain' => {
    return mode === 'markdown' ? 'markdown' : 'plain';
};

const triggerIconSpecForMessageReference = (
    decoration: MessageReferenceDecoration,
): ComposerTriggerIconSpec | undefined => {
    switch (decoration.kind) {
        case 'session':
            return { trigger: '@', icon: 'chat-thread', label: decoration.label };
        case 'skill':
            return { trigger: '/', icon: 'book-open', label: decoration.label.replace(/^\//, '') };
        case 'command':
            return { trigger: '/', icon: 'command', label: decoration.label.replace(/^\//, '') };
        case 'image':
            return { trigger: '[', icon: 'file-image', label: decoration.label, suffix: ']' };
        case 'attachment':
            return { trigger: '[', icon: 'attachment-2', label: decoration.label, suffix: ']' };
        case 'file':
        case 'agent':
            return undefined;
    }
};

const MessageReferenceChip: React.FC<{
    decoration: MessageReferenceDecoration;
    onOpenSkill?: (skillName: string) => void;
}> = ({ decoration, onOpenSkill }) => {
    const triggerIconSpec = triggerIconSpecForMessageReference(decoration);
    const content = (
        <span className={cn(
            triggerIconSpec ? 'mx-1 inline-flex max-w-[calc(100%-0.5rem)] items-center gap-[0.4em] align-middle' : 'inline-flex items-baseline gap-0.5 align-baseline',
            decoration.className,
        )}>
            {triggerIconSpec ? (
                <>
                    <Icon name={triggerIconSpec.icon as IconName} className="size-[1em] shrink-0" aria-hidden="true" />
                    <span className="min-w-0 break-all">{triggerIconSpec.label}</span>
                </>
            ) : decoration.icon ? (
                <Icon name={decoration.icon} className="relative top-[0.1em] size-[1em] shrink-0" aria-hidden="true" />
            ) : null}
            {triggerIconSpec ? null : <span>{decoration.label}</span>}
        </span>
    );

    if (decoration.kind === 'skill' && decoration.skillName && onOpenSkill) {
        return (
            <button
                type="button"
                className="inline align-baseline hover:underline"
                data-skill-name={decoration.skillName}
                onClick={(event) => {
                    event.stopPropagation();
                    onOpenSkill(decoration.skillName!);
                }}
            >
                {content}
            </button>
        );
    }

    if (decoration.kind === 'agent' && decoration.href) {
        return (
            <a
                href={buildAgentMentionUrl(decoration.agentName || decoration.label.replace(/^@/, ''))}
                className="inline align-baseline hover:underline"
                target="_blank"
                rel="noopener noreferrer"
                data-openchamber-agent-mention="true"
                onClick={(event) => event.stopPropagation()}
            >
                {content}
            </a>
        );
    }

    return content;
};

const UserTextPart: React.FC<UserTextPartProps> = ({ part, messageId, agentMention, messageParts }) => {
    const partWithText = part as PartWithText;
    const rawText = partWithText.text;
    const textContent = typeof rawText === 'string' ? rawText : partWithText.content || partWithText.value || '';

    const [isExpanded, setIsExpanded] = React.useState(false);
    const [isTruncated, setIsTruncated] = React.useState(false);
    const userMessageRenderingMode = useUIStore((state) => state.userMessageRenderingMode);
    const collapsibleUserMessages = useUIStore((state) => state.collapsibleUserMessages);
    const effectiveDirectory = useEffectiveDirectory();
    const skillsQuery = useInstalledSkillsQuery({
        directory: effectiveDirectory,
        enabled: hasPotentialSkillToken(textContent),
    });
    const skills = React.useMemo(() => skillsQuery.data ?? [], [skillsQuery.data]);
    const openContextFile = useUIStore((state) => state.openContextFile);
    const { t } = useI18n();
    const normalizedRenderingMode = normalizeUserMessageRenderingMode(userMessageRenderingMode);
    const isCollapsed = collapsibleUserMessages && !isExpanded;
    const textRef = React.useRef<HTMLDivElement>(null);
    const skillByName = React.useMemo(() => new Map(skills.map((skill) => [skill.name, skill])), [skills]);
    const citationIcons = React.useMemo(() => buildCitationIconsFromParts(messageParts), [messageParts]);

    const openSkill = React.useCallback((name: string) => {
        const skill = skillByName.get(name);
        if (!skill?.path) return;
        openContextFile(effectiveDirectory || getDirectoryForFilePath('', skill.path) || '/', skill.path);
    }, [effectiveDirectory, openContextFile, skillByName]);

    const hasActiveSelectionInElement = React.useCallback((element: HTMLElement): boolean => {
        if (typeof window === 'undefined') {
            return false;
        }

        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            return false;
        }

        const range = selection.getRangeAt(0);
        return element.contains(range.startContainer) || element.contains(range.endContainer);
    }, []);

    React.useEffect(() => {
        const el = textRef.current;
        if (!el) return;

        const checkTruncation = () => {
            if (collapsibleUserMessages && !isExpanded) {
                setIsTruncated(el.scrollHeight > el.clientHeight);
            }
        };

        checkTruncation();

        const resizeObserver = new ResizeObserver(checkTruncation);
        resizeObserver.observe(el);

        return () => resizeObserver.disconnect();
    }, [collapsibleUserMessages, textContent, isExpanded]);

    React.useEffect(() => {
        if (!collapsibleUserMessages) {
            setIsExpanded(false);
            setIsTruncated(false);
        }
    }, [collapsibleUserMessages]);

    const handleClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement | null;
        const skillLink = target?.closest<HTMLElement>('[data-skill-name]');
        const skillName = skillLink?.dataset.skillName
            ?? parseSkillHref(target?.closest<HTMLAnchorElement>('a[href]')?.getAttribute('href'));
        if (skillName) {
            event.preventDefault();
            event.stopPropagation();
            openSkill(skillName);
            return;
        }

        const element = textRef.current;
        if (!element) {
            return;
        }

        if (hasActiveSelectionInElement(element)) {
            return;
        }

        if (collapsibleUserMessages && !isExpanded && isTruncated) {
            setIsExpanded(true);
        }
    }, [collapsibleUserMessages, hasActiveSelectionInElement, isExpanded, isTruncated, openSkill]);

    const handleCollapse = React.useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
        setIsExpanded(false);
    }, []);

    const referenceParts = React.useMemo(() => {
        return buildMessageReferenceParts(textContent, {
            skillNames: new Set(skillByName.keys()),
            citationIcons,
            agentNames: agentMention?.name
                ? new Set([agentMention.name.toLowerCase(), agentMention.token.replace(/^@/, '').toLowerCase()])
                : undefined,
            allowPathHeuristics: true,
        });
    }, [agentMention, citationIcons, skillByName, textContent]);

    const processedMarkdownContent = React.useMemo(() => {
        return prepareUserMarkdownContent({
            textContent,
            agentMention,
            skillNames: new Set(skillByName.keys()),
            // Shared chips already own skill/agent presentation when present.
            decorateInlineReferences: !referenceParts,
        });
    }, [agentMention, referenceParts, skillByName, textContent]);

    const renderTextSegment = React.useCallback((segment: string, key: string): React.ReactNode => {
        if (!segment) return null;
        if (normalizedRenderingMode === 'markdown') {
            const markdown = prepareUserMarkdownContent({
                textContent: segment,
                skillNames: new Set(),
                decorateInlineReferences: false,
            });
            return (
                <SimpleMarkdownRenderer
                    key={key}
                    content={markdown}
                    className={cn(
                        "[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0",
                        isCollapsed && [
                            "[&_.markdown-content>*]:my-0",
                            "[&_[data-component='markdown-code']]:my-0",
                            "[&_[data-component='markdown-code']]:inline",
                            "[&_[data-component='markdown-code']]:border-0",
                            "[&_[data-component='markdown-code']]:bg-transparent",
                            "[&_[data-component='markdown-code']>*:first-child]:hidden",
                            "[&_[data-component='markdown-code']>div]:inline",
                            "[&_[data-component='markdown-code']>div]:p-0",
                            "[&_[data-component='markdown-code']_pre]:inline",
                            "[&_[data-component='markdown-code']_code]:inline",
                            "[&_[data-md-code-line-numbers]]:hidden",
                        ]
                    )}
                    disableLinkSafety
                    enableFileReferences={false}
                />
            );
        }
        return <React.Fragment key={key}>{segment}</React.Fragment>;
    }, [isCollapsed, normalizedRenderingMode]);

    const renderReferenceParts = React.useCallback((parts: MessageTextPart[]): React.ReactNode => {
        return parts.map((partItem, index) => {
            if (partItem.type === 'text') {
                return renderTextSegment(partItem.text, `text-${index}`);
            }
            return (
                <MessageReferenceChip
                    key={`ref-${index}-${partItem.span.start}`}
                    decoration={partItem.decoration}
                    onOpenSkill={openSkill}
                />
            );
        });
    }, [openSkill, renderTextSegment]);

    const plainTextContent = React.useMemo(() => {
        if (referenceParts) {
            return renderReferenceParts(referenceParts);
        }

        const nodes: React.ReactNode[] = [];
        let cursor = 0;
        let agentMentionUsed = false;
        let match: RegExpExecArray | null;
        SKILL_TOKEN_PATTERN.lastIndex = 0;

        while ((match = SKILL_TOKEN_PATTERN.exec(textContent)) !== null) {
            const prefix = match[1] || '';
            const skillName = match[2];
            const slashIndex = match.index + prefix.length;
            if (!skillByName.has(skillName)) continue;

            if (match.index > cursor) nodes.push(textContent.slice(cursor, match.index));
            if (prefix) nodes.push(prefix);
            nodes.push(
                <button
                    key={`skill-${slashIndex}-${skillName}`}
                    type="button"
                    className="text-primary hover:underline"
                    onClick={(event) => {
                        event.stopPropagation();
                        openSkill(skillName);
                    }}
                >
                    /{skillName}
                </button>
            );
            cursor = slashIndex + skillName.length + 1;
        }

        if (cursor < textContent.length) nodes.push(textContent.slice(cursor));

        const withSkills = nodes.length > 0 ? nodes : [textContent];
        if (!agentMention?.token || !textContent.includes(agentMention.token)) {
            return withSkills;
        }

        return withSkills.flatMap((node, index) => {
            if (agentMentionUsed || typeof node !== 'string') return node;
            const idx = node.indexOf(agentMention.token);
            if (idx === -1) return node;
            agentMentionUsed = true;
            return [
                node.slice(0, idx),
                <a
                    key={`agent-${index}`}
                    href={buildAgentMentionUrl(agentMention.name)}
                    className="text-primary hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => event.stopPropagation()}
                >
                    {agentMention.token}
                </a>,
                node.slice(idx + agentMention.token.length),
            ];
        });
    }, [agentMention, openSkill, referenceParts, renderReferenceParts, skillByName, textContent]);

    if (!textContent || textContent.trim().length === 0) {
        return null;
    }

    return (
        <div className="relative" key={part.id || `${messageId}-user-text`}>
            {collapsibleUserMessages && isExpanded && (
                <button
                    type="button"
                    onClick={handleCollapse}
                    className="absolute top-0 right-0 z-10 flex items-center justify-center rounded-sm bg-[var(--surface-elevated)] p-0.5 text-[var(--surface-mutedForeground)] hover:text-[var(--surface-foreground)] hover:bg-[var(--interactive-hover)] transition-colors"
                    aria-label={t('chat.message.userText.collapseAria')}
                >
                    <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
                </button>
            )}
            <div
                className={cn(
                    "break-words font-sans typography-markdown-body",
                    isExpanded && "pb-3",
                    normalizedRenderingMode === 'plain' && 'whitespace-pre-wrap',
                    isCollapsed && "line-clamp-10",
                    collapsibleUserMessages && isTruncated && !isExpanded && "cursor-pointer"
                )}
                ref={textRef}
                onClick={handleClick}
            >
                {normalizedRenderingMode === 'markdown' ? (
                    referenceParts ? (
                        renderReferenceParts(referenceParts)
                    ) : (
                        <SimpleMarkdownRenderer
                            content={processedMarkdownContent}
                            className={cn(
                                "[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0",
                                isCollapsed && [
                                    "[&_.markdown-content>*]:my-0",
                                    "[&_[data-component='markdown-code']]:my-0",
                                    "[&_[data-component='markdown-code']]:inline",
                                    "[&_[data-component='markdown-code']]:border-0",
                                    "[&_[data-component='markdown-code']]:bg-transparent",
                                    "[&_[data-component='markdown-code']>*:first-child]:hidden",
                                    "[&_[data-component='markdown-code']>div]:inline",
                                     "[&_[data-component='markdown-code']>div]:p-0",
                                     "[&_[data-component='markdown-code']_pre]:inline",
                                     "[&_[data-component='markdown-code']_code]:inline",
                                     "[&_[data-md-code-line-numbers]]:hidden",
                                 ]
                            )}
                            disableLinkSafety
                            enableFileReferences={false}
                        />
                    )
                ) : (
                    plainTextContent
                )}
            </div>
        </div>
    );
};

export default React.memo(UserTextPart);
