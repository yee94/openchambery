import React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { markOverlayScrimPress, shouldCommitOverlayScrimDismiss } from './matchingPress';
import { ScrollableOverlay } from './ScrollableOverlay';
import { Icon } from "@/components/icon/Icon";

interface MobileOverlayPanelProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  contentMaxHeightClassName?: string;
  renderHeader?: (closeButton: React.ReactNode) => React.ReactNode;
  containedBody?: boolean;
  closeAriaLabel?: string;
}

const OVERLAY_ROOT_ID = 'mobile-overlay-root';
// Entrance animation: classic slide up from the bottom + scrim fade.
const ENTER_DELAY_MS = 16;
const ENTER_DURATION_MS = 200;
const openOverlayStack: symbol[] = [];
let bodyLockDepth = 0;
let bodyOverflowBeforeLock = '';
let overlaySignalDepth = 0;

const ensureOverlayRoot = () => {
  if (typeof document === 'undefined') return null;
  let root = document.getElementById(OVERLAY_ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = OVERLAY_ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
};

export const MobileOverlayPanel: React.FC<MobileOverlayPanelProps> = ({
  open,
  title,
  onClose,
  children,
  footer,
  className,
  contentMaxHeightClassName,
  renderHeader,
  containedBody = false,
  closeAriaLabel,
}) => {
  const overlayRootRef = React.useRef<HTMLElement | null>(null);
  const overlayIDRef = React.useRef(Symbol('mobile-overlay'));
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const [entered, setEntered] = React.useState(false);
  // True once the enter transition has finished. While entering, the panel's
  // keyboard-inset bottom anchor must NOT animate: opening an overlay usually
  // closes the keyboard at the same moment, and a transitioning `bottom` under
  // the panel's own rise made the entrance jerky / offset. During the enter the
  // anchor snaps to its final value and only the rise animates.
  const [enterSettled, setEnterSettled] = React.useState(false);

  if (typeof document !== 'undefined' && !overlayRootRef.current) {
    overlayRootRef.current = ensureOverlayRoot();
  }

  // Replay the enter transition on each open (rise + scrim fade).
  React.useEffect(() => {
    if (!open) {
      setEntered(false);
      setEnterSettled(false);
      return;
    }
    const id = window.setTimeout(() => setEntered(true), ENTER_DELAY_MS);
    const settleId = window.setTimeout(
      () => setEnterSettled(true),
      ENTER_DELAY_MS + ENTER_DURATION_MS + 50,
    );
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(settleId);
    };
  }, [open]);

  // Synchronous close signal: this layout-effect cleanup runs inside the same
  // React flush as the user click that closed the panel, so listeners (e.g.
  // the keyboard-restore in ChatInput) can refocus an input while iOS still
  // considers the gesture active — a deferred focus() would not raise the
  // keyboard in an installed PWA.
  React.useLayoutEffect(() => {
    if (!open) return;
    if (overlaySignalDepth === 0) {
      window.dispatchEvent(new Event('oc:mobile-overlay-opened'));
    }
    overlaySignalDepth += 1;
    return () => {
      overlaySignalDepth = Math.max(0, overlaySignalDepth - 1);
      if (overlaySignalDepth === 0) {
        window.dispatchEvent(new Event('oc:mobile-overlay-closed'));
      }
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const overlayID = overlayIDRef.current;
    openOverlayStack.push(overlayID);
    if (bodyLockDepth === 0) {
      bodyOverflowBeforeLock = document.body.style.overflow;
    }
    bodyLockDepth += 1;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openOverlayStack[openOverlayStack.length - 1] === overlayID) {
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      const stackIndex = openOverlayStack.lastIndexOf(overlayID);
      if (stackIndex >= 0) {
        openOverlayStack.splice(stackIndex, 1);
      }
      bodyLockDepth = Math.max(0, bodyLockDepth - 1);
      if (bodyLockDepth === 0) {
        document.body.style.overflow = bodyOverflowBeforeLock;
      }
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!open || !overlayRootRef.current) {
    return null;
  }

  const contentMaxHeight = contentMaxHeightClassName ?? 'max-h-[min(70vh,520px)]';

  const content = (
    <div
      className={cn(
        'oc-keyboard-inset-surface fixed inset-0 z-[60] flex flex-col bg-[rgb(0_0_0_/_0.45)] transition-opacity duration-200 ease-out',
        !enterSettled && 'oc-keyboard-inset-snap',
        entered ? 'opacity-100' : 'opacity-0',
      )}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onPointerDown={markOverlayScrimPress}
      onClick={(event) => {
        if (!shouldCommitOverlayScrimDismiss(event)) return;
        onClose();
      }}
    >
        <div
          className={cn(
            'mt-auto flex max-h-[calc(100dvh-0.75rem)] min-h-0 w-full flex-col rounded-t-xl border-x border-t border-border/50 bg-background pb-[max(0.5rem,var(--oc-app-bottom-safe,0px),var(--oc-safe-area-bottom,env(safe-area-inset-bottom,0px)))] shadow-none pwa-overlay-panel',
            'mx-auto max-w-lg',
            className
          )}
          style={{
            transform: entered ? 'none' : 'translateY(100%)',
            transition: `transform ${ENTER_DURATION_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
          }}
          onClick={(event) => event.stopPropagation()}
        >
        {(() => {
          const closeButton = (
            <button
              type="button"
              onClick={onClose}
              className={cn('flex items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover', containedBody ? 'size-11' : 'h-8 w-8')}
              aria-label={closeAriaLabel ?? title}
            >
              <Icon name="close" className="h-4 w-4" />
            </button>
          );

          if (renderHeader) {
            return renderHeader(closeButton);
          }

          return (
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
              <h2 className="typography-ui-label font-semibold text-foreground">{title}</h2>
              {closeButton}
            </div>
          );
        })()}
        {containedBody ? (
          <div className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', contentMaxHeight)}>
            {children}
          </div>
        ) : (
          <ScrollableOverlay
            useScrollShadow
            disableHorizontal
            // Contain the scroll inside the panel: without this, iOS chains the
            // rubber-band overscroll to the page behind the sheet, which reads
            // as a weird content bounce while scrolling the overlay.
            preventOverscroll
            outerClassName={cn('min-h-0 flex-1', contentMaxHeight)}
            className="px-2 py-2 pwa-overlay-scroll"
          >
            {children}
          </ScrollableOverlay>
        )}
        {footer ? (
          <div className="shrink-0 border-t border-border/40 px-3 py-2">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );

  return createPortal(content, overlayRootRef.current);
};
