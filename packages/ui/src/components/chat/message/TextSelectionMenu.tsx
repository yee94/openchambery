import React from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { cn, isMacOS } from '@/lib/utils';
import { useEvent } from '@reactuses/core';
import { useI18n } from '@/lib/i18n';
import { eventMatchesShortcut, formatShortcutForDisplay } from '@/lib/shortcuts';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { composerQuoteKey } from '@/stores/composerQuotes';
import { useComposerQuoteStore } from '@/stores/useComposerQuoteStore';
import { useSessionBtwStore } from '@/stores/useSessionBtwStore';
import { openSessionBtw } from '@/components/layout/btwComposerFocus';
import { subscribeSessionSwitchIntent } from '@/lib/sessionSwitchIntent';
import { getSessionSurfaceActionAvailability, useSessionSurface } from '../SessionSurfaceContext';

interface TextSelectionMenuProps {
  containerRef: React.RefObject<HTMLElement | null>;
}

interface MenuPosition {
  x: number;
  y: number;
  show: boolean;
}

interface SelectionPayload {
  plainText: string;
  markdownText: string;
  rect: DOMRect;
}

const DESKTOP_MENU_SIDE_MARGIN_PX = 8;
const ADD_TO_CHAT_SHORTCUT = 'mod+l';
const ADD_TO_SIDE_CHAT_SHORTCUT = 'mod+shift+s';
const MAC_MODIFIER_ORDER = ['⌃', '⌥', '⇧', '⌘'];

const formatCompactShortcut = (combo: string): string => {
  const tokens = formatShortcutForDisplay(combo).split(' + ');
  if (!isMacOS()) return tokens.join('+');
  const key = tokens[tokens.length - 1];
  const modifiers = tokens.slice(0, -1).sort((a, b) => MAC_MODIFIER_ORDER.indexOf(a) - MAC_MODIFIER_ORDER.indexOf(b));
  return [...modifiers, key].join('');
};
const DESKTOP_MENU_FALLBACK_WIDTH_PX = 280;
let dismissVisibleTextSelectionMenu: (() => void) | null = null;

subscribeSessionSwitchIntent(() => {
  if (typeof window !== 'undefined') {
    window.getSelection()?.removeAllRanges();
  }
  if (dismissVisibleTextSelectionMenu) {
    flushSync(dismissVisibleTextSelectionMenu);
  }
});

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'ul',
]);

const normalizeLineBreaks = (value: string): string => value.replace(/\r\n?/g, '\n');

const trimSelectionValue = (value: string): string => normalizeLineBreaks(value).trim();

const isSelectionNodeWithinContainer = (container: HTMLElement, node: Node): boolean => {
  if (container.contains(node)) {
    return true;
  }

  const root = node instanceof ShadowRoot ? node : node.getRootNode();
  return root instanceof ShadowRoot && container.contains(root.host);
};

const getOpenShadowRoots = (container: HTMLElement): ShadowRoot[] => {
  const roots: ShadowRoot[] = [];
  const visit = (root: ParentNode) => {
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) {
        roots.push(element.shadowRoot);
        visit(element.shadowRoot);
      }
    }
  };
  visit(container);
  return roots;
};

const getSelectionRangeWithinContainer = (selection: Selection, container: HTMLElement): Range | null => {
  const shadowRoots = getOpenShadowRoots(container);
  const composedRange = selection.getComposedRanges?.({ shadowRoots })[0];
  if (composedRange) {
    const range = document.createRange();
    range.setStart(composedRange.startContainer, composedRange.startOffset);
    range.setEnd(composedRange.endContainer, composedRange.endOffset);
    if (isSelectionNodeWithinContainer(container, range.commonAncestorContainer)) {
      return range;
    }
  }

  if (selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  return isSelectionNodeWithinContainer(container, range.commonAncestorContainer) ? range : null;
};

const textToMarkdownInline = (value: string): string => value.replace(/\s+/g, ' ').trim();

const renderInlineMarkdownNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    return textToMarkdownInline(node.textContent || '');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const childText = Array.from(element.childNodes)
    .map((child) => renderInlineMarkdownNode(child))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  if (!childText && tag !== 'br') {
    return '';
  }

  if (tag === 'br') return '\n';
  if (tag === 'strong' || tag === 'b') return `**${childText}**`;
  if (tag === 'em' || tag === 'i') return `*${childText}*`;
  if (tag === 'code') return `\`${childText.replace(/`/g, '\\`')}\``;
  if (tag === 'a') {
    const href = element.getAttribute('href');
    return href ? `[${childText}](${href})` : childText;
  }

  return childText;
};

const renderListMarkdown = (list: HTMLElement, ordered: boolean): string => {
  const items = Array.from(list.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.tagName.toLowerCase() === 'li'
  );

  return items
    .map((item, index) => {
      const prefix = ordered ? `${index + 1}. ` : '- ';
      const body = Array.from(item.childNodes)
        .map((child) => renderInlineMarkdownNode(child))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      return body ? `${prefix}${body}` : '';
    })
    .filter(Boolean)
    .join('\n');
};

const renderBlockMarkdownNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    return trimSelectionValue(node.textContent || '');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();

  if (tag === 'pre') {
    const codeElement = element.querySelector('code');
    const languageClass = codeElement?.className || '';
    const language = (languageClass.match(/language-([\w-]+)/)?.[1] || '').trim();
    const code = normalizeLineBreaks(codeElement?.textContent || element.textContent || '').replace(/\n$/, '');
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }

  if (tag === 'code') {
    const code = normalizeLineBreaks(element.textContent || '').trim();
    return code ? `\`${code.replace(/`/g, '\\`')}\`` : '';
  }

  if (tag === 'ul') return renderListMarkdown(element, false);
  if (tag === 'ol') return renderListMarkdown(element, true);

  if (tag === 'blockquote') {
    const content = trimSelectionValue(
      Array.from(element.childNodes).map((child) => renderBlockMarkdownNode(child)).join('\n')
    );
    return content
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => `> ${line}`)
      .join('\n');
  }

  if (/^h[1-6]$/.test(tag)) {
    const level = Number.parseInt(tag[1], 10);
    const text = trimSelectionValue(Array.from(element.childNodes).map((child) => renderInlineMarkdownNode(child)).join(''));
    return text ? `${'#'.repeat(level)} ${text}` : '';
  }

  if (tag === 'p' || tag === 'div' || tag === 'li') {
    return trimSelectionValue(Array.from(element.childNodes).map((child) => renderInlineMarkdownNode(child)).join(''));
  }

  const blockChildren = Array.from(element.childNodes)
    .map((child) => renderBlockMarkdownNode(child))
    .filter((child) => child.length > 0);
  if (blockChildren.length > 0) {
    return blockChildren.join('\n\n');
  }

  return trimSelectionValue(Array.from(element.childNodes).map((child) => renderInlineMarkdownNode(child)).join(''));
};

const isInlineSelectionFragment = (fragment: DocumentFragment): boolean => {
  return Array.from(fragment.childNodes).every((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return true;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return true;
    }

    const element = node as HTMLElement;
    return !BLOCK_TAGS.has(element.tagName.toLowerCase());
  });
};

const rangeToMarkdown = (range: Range, plainText: string): string => {
  const fragment = range.cloneContents();

  if (isInlineSelectionFragment(fragment)) {
    const inlineMarkdown = trimSelectionValue(
      Array.from(fragment.childNodes)
        .map((node) => renderInlineMarkdownNode(node))
        .join('')
    );
    if (inlineMarkdown) {
      return inlineMarkdown;
    }
  }

  const markdown = Array.from(fragment.childNodes)
    .map((node) => renderBlockMarkdownNode(node))
    .filter((value) => value.length > 0)
    .join('\n\n')
    .trim();

  return markdown || trimSelectionValue(plainText);
};

export const TextSelectionMenu: React.FC<TextSelectionMenuProps> = ({ containerRef }) => {
  const { t } = useI18n();
  const [position, setPosition] = React.useState<MenuPosition>({ x: 0, y: 0, show: false });
  const [selectedTextMarkdown, setSelectedTextMarkdown] = React.useState('');
  const isDraggingRef = React.useRef(false);
  const [isOpening, setIsOpening] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const menuWidthRef = React.useRef(DESKTOP_MENU_FALLBACK_WIDTH_PX);
  const pendingSelectionRef = React.useRef<SelectionPayload | null>(null);
  const openRafRef = React.useRef<number | null>(null);
  const mouseUpTimeoutRef = React.useRef<number | null>(null);
  const isMenuVisibleRef = React.useRef(false);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const effectiveDirectory = useEffectiveDirectory() ?? null;
  const isMobile = useUIStore((state) => state.isMobile);
  const sessionSurface = useSessionSurface();
  const canUseTextSelectionActions = getSessionSurfaceActionAvailability(sessionSurface).textSelectionMutation;
  const canAddToSideChat = sessionSurface.kind === 'primary' && Boolean(currentSessionId);

  React.useEffect(() => {
    isMenuVisibleRef.current = position.show;
  }, [position.show]);

  React.useEffect(() => {
    return () => {
      if (openRafRef.current !== null) {
        window.cancelAnimationFrame(openRafRef.current);
        openRafRef.current = null;
      }
      if (mouseUpTimeoutRef.current !== null) {
        window.clearTimeout(mouseUpTimeoutRef.current);
        mouseUpTimeoutRef.current = null;
      }
    };
  }, []);

  const hideMenu = React.useCallback(() => {
    pendingSelectionRef.current = null;
    if (dismissVisibleTextSelectionMenu === hideMenu) {
      dismissVisibleTextSelectionMenu = null;
    }

    if (!isMenuVisibleRef.current) {
      return;
    }

    if (openRafRef.current !== null) {
      window.cancelAnimationFrame(openRafRef.current);
      openRafRef.current = null;
    }
    setIsOpening(false);

    setPosition((prev) => ({ ...prev, show: false }));
    setSelectedTextMarkdown('');
    isMenuVisibleRef.current = false;
  }, []);

  React.useEffect(() => () => {
    if (dismissVisibleTextSelectionMenu === hideMenu) {
      dismissVisibleTextSelectionMenu = null;
    }
  }, [hideMenu]);

  const getDesktopClampedX = React.useCallback((anchorX: number) => {
    if (typeof window === 'undefined') {
      return anchorX;
    }

    const viewportWidth = window.innerWidth;
    const menuWidth = menuWidthRef.current;
    const halfWidth = menuWidth / 2;
    const minX = DESKTOP_MENU_SIDE_MARGIN_PX + halfWidth;
    const maxX = viewportWidth - DESKTOP_MENU_SIDE_MARGIN_PX - halfWidth;

    if (minX > maxX) {
      return viewportWidth / 2;
    }

    return Math.min(Math.max(anchorX, minX), maxX);
  }, []);

  const showMenu = React.useCallback(() => {
    if (!pendingSelectionRef.current) return;

    if (dismissVisibleTextSelectionMenu !== hideMenu) {
      dismissVisibleTextSelectionMenu?.();
      dismissVisibleTextSelectionMenu = hideMenu;
    }

    const { markdownText, rect } = pendingSelectionRef.current;
    const shouldAnimateIn = !position.show;

    // Position menu above the selection
    const menuX = isMobile
      ? rect.left + rect.width / 2
      : getDesktopClampedX(rect.left + rect.width / 2);
    const menuY = rect.top - 10;

    setSelectedTextMarkdown(markdownText);
    setPosition({
      x: menuX,
      y: menuY,
      show: true,
    });
    isMenuVisibleRef.current = true;

    if (shouldAnimateIn) {
      setIsOpening(true);
      if (openRafRef.current !== null) {
        window.cancelAnimationFrame(openRafRef.current);
      }
      openRafRef.current = window.requestAnimationFrame(() => {
        setIsOpening(false);
        openRafRef.current = null;
      });
    }
  }, [getDesktopClampedX, hideMenu, isMobile, position.show]);

  React.useLayoutEffect(() => {
    if (!position.show || isMobile || !menuRef.current) {
      return;
    }

    const measuredWidth = menuRef.current.offsetWidth;
    if (!Number.isFinite(measuredWidth) || measuredWidth <= 0 || measuredWidth === menuWidthRef.current) {
      return;
    }

    menuWidthRef.current = measuredWidth;
    setPosition((prev) => ({
      ...prev,
      x: getDesktopClampedX(prev.x),
    }));
  }, [getDesktopClampedX, isMobile, position.show]);

  React.useEffect(() => {
    if (!position.show || isMobile) {
      return;
    }

    const handleViewportResize = () => {
      setPosition((prev) => ({
        ...prev,
        x: getDesktopClampedX(prev.x),
      }));
    };

    window.addEventListener('resize', handleViewportResize);
    return () => {
      window.removeEventListener('resize', handleViewportResize);
    };
  }, [getDesktopClampedX, isMobile, position.show]);

  const handleSelectionChange = React.useCallback(() => {
    const selection = window.getSelection();
    const container = containerRef.current;

    if (!selection || !container) {
      if (!isDraggingRef.current) {
        hideMenu();
      }
      return;
    }

    const text = trimSelectionValue(selection.toString());

    // Only show if we have text and the selection is within our container
    if (!text) {
      if (!isDraggingRef.current) {
        hideMenu();
      }
      return;
    }

    const range = getSelectionRangeWithinContainer(selection, container);
    if (!range) {
      if (!isDraggingRef.current) {
        hideMenu();
      }
      return;
    }

    // Get selection coordinates
    const rect = range.getBoundingClientRect();

    // Store the selection but don't show menu yet if dragging
    pendingSelectionRef.current = {
      plainText: text,
      markdownText: rangeToMarkdown(range, text),
      rect,
    };

    // Only show menu if we're not currently dragging
    if (!isDraggingRef.current) {
      showMenu();
    }
  }, [containerRef, hideMenu, showMenu]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Track when dragging starts
    const handleMouseDown = () => {
      isDraggingRef.current = true;
      hideMenu();
    };

    // Track when dragging stops
    const handleMouseUp = () => {
      isDraggingRef.current = false;
      if (mouseUpTimeoutRef.current !== null) {
        window.clearTimeout(mouseUpTimeoutRef.current);
      }
      // Read the finalized selection directly. Shadow-root selectionchange may
      // finish after the document-level mouseup event.
      mouseUpTimeoutRef.current = window.setTimeout(() => {
        mouseUpTimeoutRef.current = null;
        handleSelectionChange();
      }, 10);
    };

    const shadowRoots = new Set<ShadowRoot>();
    const bindShadowRootListeners = () => {
      for (const root of getOpenShadowRoots(container)) {
        if (shadowRoots.has(root)) continue;
        shadowRoots.add(root);
        root.addEventListener('selectionchange', handleSelectionChange);
      }
    };

    bindShadowRootListeners();
    const shadowRootObserver = new MutationObserver(bindShadowRootListeners);
    shadowRootObserver.observe(container, { childList: true, subtree: true });

    // Listen on both the document and embedded diff shadow roots.
    document.addEventListener('selectionchange', handleSelectionChange);
    
    container.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);

    // Hide menu when clicking outside
    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        !window.getSelection()?.toString().trim()
      ) {
        hideMenu();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      if (mouseUpTimeoutRef.current !== null) {
        window.clearTimeout(mouseUpTimeoutRef.current);
        mouseUpTimeoutRef.current = null;
      }
      shadowRootObserver.disconnect();
      for (const root of shadowRoots) {
        root.removeEventListener('selectionchange', handleSelectionChange);
      }
      document.removeEventListener('selectionchange', handleSelectionChange);
      container.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [containerRef, handleSelectionChange, hideMenu, showMenu]);

  // The selection menu is viewport-fixed (mobile bottom bar and the desktop
  // popup alike), so it detaches from the selection the moment the underlying
  // content scrolls — dismiss it. Scroll events do not bubble, so listen in
  // the capture phase to catch scrolls inside nested containers and shadow
  // roots. Selection-handle drags that auto-scroll the container fire
  // selectionchange afterwards, which re-shows the bar for the adjusted
  // selection.
  React.useEffect(() => {
    if (!position.show) return;

    const handleScroll = (event: Event) => {
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) {
        return;
      }
      hideMenu();
    };

    window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [position.show, hideMenu]);

  const clearSelection = () => {
    hideMenu();
    window.getSelection()?.removeAllRanges();
  };

  const addSelectionToChat = useEvent((markdownText: string) => {
    if (!markdownText) return;
    const draftId = useSessionUIStore.getState().newSessionDraft.draftID;
    const key = composerQuoteKey(currentSessionId, draftId);
    if (!key) return;
    useComposerQuoteStore.getState().addQuote(key, markdownText);
    clearSelection();
    requestAnimationFrame(() => {
      const composer = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea[data-chat-input="true"]'))
        .find((node) => !node.closest('[data-btw-composer]'));
      composer?.focus();
    });
  });

  const addSelectionToSideChat = useEvent((markdownText: string) => {
    if (!markdownText || !currentSessionId) return;
    const scope = { sessionId: currentSessionId, directory: effectiveDirectory };
    useSessionBtwStore.getState().addQuote(scope, markdownText);
    clearSelection();
    openSessionBtw(scope);
  });

  React.useEffect(() => {
    if (!canUseTextSelectionActions) return;
    // Capture phase: with a live selection these win over global bindings (mod+shift+s services menu).
    const handleKeyDown = (event: KeyboardEvent) => {
      const toChat = eventMatchesShortcut(event, ADD_TO_CHAT_SHORTCUT);
      const toSideChat = canAddToSideChat && eventMatchesShortcut(event, ADD_TO_SIDE_CHAT_SHORTCUT);
      if (!toChat && !toSideChat) return;
      const selection = window.getSelection();
      const container = containerRef.current;
      if (!selection || !container || !selection.toString().trim()) return;
      const range = getSelectionRangeWithinContainer(selection, container);
      if (!range) return;
      event.preventDefault();
      event.stopPropagation();
      const markdown = rangeToMarkdown(range, selection.toString());
      if (toChat) addSelectionToChat(markdown);
      else addSelectionToSideChat(markdown);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [addSelectionToChat, addSelectionToSideChat, canAddToSideChat, canUseTextSelectionActions, containerRef]);

  if (!position.show || !canUseTextSelectionActions) return null;

  const actions = [
    { id: 'chat', label: t('chat.textSelection.actions.addToChat'), shortcut: ADD_TO_CHAT_SHORTCUT, run: () => addSelectionToChat(selectedTextMarkdown) },
    ...(canAddToSideChat
      ? [{ id: 'side', label: t('chat.textSelection.actions.addToSideChat'), shortcut: ADD_TO_SIDE_CHAT_SHORTCUT, run: () => addSelectionToSideChat(selectedTextMarkdown) }]
      : []),
  ];

  // Mobile: a slim bar at the bottom of the screen, above the keyboard
  if (isMobile) {
    return createPortal(
      <div
        ref={menuRef}
        data-text-selection-menu
        className={cn(
          'fixed left-3 right-3 z-50 mx-auto flex max-w-[420px] items-center gap-1',
          'rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-0.5 shadow-sm',
          'transition-[opacity,transform] duration-200 ease-out will-change-[opacity,transform]',
          isOpening ? 'opacity-0 translate-y-[4px]' : 'opacity-100 translate-y-0'
        )}
        style={{ bottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))' }}
      >
        {actions.map((action, index) => (
          <React.Fragment key={action.id}>
            {index > 0 ? <div className="h-4 w-px shrink-0 bg-[var(--interactive-border)]" /> : null}
            <button
              type="button"
              onClick={action.run}
              className="h-8 min-w-0 flex-1 truncate rounded-md px-3 typography-meta text-[var(--surface-foreground)] active:bg-[var(--interactive-hover)]"
            >
              {action.label}
            </button>
          </React.Fragment>
        ))}
      </div>,
      document.body
    );
  }

  // Desktop: a compact pill above the selection
  return createPortal(
    <div
      ref={menuRef}
      data-text-selection-menu
      className="fixed z-50"
      style={{
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -100%)',
      }}
    >
      <div
        className={cn(
          'flex items-center gap-0.5 whitespace-nowrap rounded-lg p-0.5',
          'border border-[var(--interactive-border)] bg-[var(--surface-elevated)] shadow-sm',
          'transition-[opacity,transform] duration-200 ease-out will-change-[opacity,transform]',
          isOpening ? 'opacity-0 translate-y-[4px]' : 'opacity-100 translate-y-0'
        )}
      >
        {actions.map((action, index) => (
          <React.Fragment key={action.id}>
            {index > 0 ? <div className="h-3 w-px shrink-0 bg-[var(--interactive-border)]" /> : null}
            <button
              type="button"
              onClick={action.run}
              className="flex h-6 items-center gap-1.5 rounded-md px-2 typography-meta text-[var(--surface-foreground)] transition-colors duration-150 hover:bg-[var(--interactive-hover)]"
            >
              <span>{action.label}</span>
              <span className="tracking-[0.08em] text-[var(--surface-muted-foreground)]" aria-hidden="true">
                {formatCompactShortcut(action.shortcut)}
              </span>
            </button>
          </React.Fragment>
        ))}
      </div>
    </div>,
    document.body
  );
};
