import React from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ShortcutKbd } from '@/components/ui/kbd';
import { useI18n } from '@/lib/i18n';

type CodeSelectionActionBubbleProps = {
  position: { x: number; y: number };
  onAddToChat: () => void;
  /**
   * Called when any content scrolls while the bubble is visible. The bubble is
   * viewport-fixed and detaches from its selection the moment the underlying
   * content moves; owners should hide it (re-selecting shows it again).
   */
  onDismiss?: () => void;
};

export function CodeSelectionActionBubble({ position, onAddToChat, onDismiss }: CodeSelectionActionBubbleProps) {
  const { t } = useI18n();
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!onDismiss) return;

    const handleScroll = (event: Event) => {
      if (containerRef.current && event.target instanceof Node && containerRef.current.contains(event.target)) {
        return;
      }
      onDismiss();
    };

    // Scroll does not bubble; capture on window catches scrolls in nested
    // containers and open shadow roots (Pierre diffs render in one).
    window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [onDismiss]);

  return createPortal(
    <div
      ref={containerRef}
      data-code-selection-action="true"
      className="fixed z-[100] -translate-y-full rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-1 shadow-lg"
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => event.preventDefault()}
    >
      <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={onAddToChat}>
        <Icon name="add" className="size-4" />
        {t('chat.textSelection.actions.addToChat')}
        <ShortcutKbd shortcut="⌘+I" />
      </Button>
    </div>,
    document.body,
  );
}
