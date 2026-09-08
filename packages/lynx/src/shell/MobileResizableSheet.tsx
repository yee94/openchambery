/**
 * Cap MobileResizableSheet spirit — grabber, half-height bottom sheet,
 * scrim + vertical dismiss. Overlay only; never nest under GlassChrome.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxText, LynxView } from '../lynx-elements';
import { cssVar } from '../theme/tokens';
import {
  LYNX_MOBILE_RESIZABLE_SHEET,
  resolveLynxMobileSheetHeightPercent,
  shouldDismissLynxMobileSheetDrag,
  toggleLynxMobileSheetSnap,
  type LynxMobileSheetSnap,
} from './mobileResizableSheet';

export type LynxMobileResizableSheetProps = {
  locale: string;
  open: boolean;
  title?: string;
  ariaLabel: string;
  onClose: () => void;
  children: ReactNode;
  /** Cap trailing slot (e.g. Save on project edit). Replaces default Close when set. */
  trailing?: ReactNode;
  /** Default half (~72dvh Cap-aligned). */
  initiallyExpanded?: boolean;
};

type TouchPoint = { clientY?: number; y?: number; pageY?: number; touches?: TouchPoint[] };

const readTouchY = (event: { detail?: unknown }): number | null => {
  const detail = event.detail as TouchPoint | undefined;
  if (!detail || typeof detail !== 'object') return null;
  const touch = detail.touches?.[0] ?? detail;
  const y = touch.clientY ?? touch.pageY ?? touch.y;
  return typeof y === 'number' && Number.isFinite(y) ? y : null;
};

/**
 * Bottom sheet overlay: dimmed scrim + half-height panel + grabber.
 * Returns null when closed.
 */
export function LynxMobileResizableSheet({
  locale,
  open,
  title,
  ariaLabel,
  onClose,
  children,
  trailing,
  initiallyExpanded = false,
}: LynxMobileResizableSheetProps) {
  const [snap, setSnap] = useState<LynxMobileSheetSnap>(
    initiallyExpanded ? 'expanded' : 'half',
  );
  const dragStartY = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      setSnap(initiallyExpanded ? 'expanded' : 'half');
      dragStartY.current = null;
    }
  }, [open, initiallyExpanded]);

  if (!open) return null;

  const height = resolveLynxMobileSheetHeightPercent(snap);

  return (
    <LynxView
      data-lynx-resizable-sheet="root"
      data-lynx-resizable-sheet-placement={LYNX_MOBILE_RESIZABLE_SHEET.placement}
      style={{
        position: 'absolute',
        left: '0',
        right: '0',
        top: '0',
        bottom: '0',
        zIndex: 40,
      }}
      accessibility-label={ariaLabel}
    >
      <LynxView
        data-lynx-resizable-sheet="scrim"
        bindtap={onClose}
        accessibility-role="button"
        accessibility-label={lynxT(locale, 'lynx.sheet.close')}
        style={{
          position: 'absolute',
          left: '0',
          right: '0',
          top: '0',
          bottom: '0',
          backgroundColor: 'rgba(0,0,0,0.45)',
        }}
      />
      <LynxView
        data-lynx-resizable-sheet="panel"
        data-lynx-resizable-sheet-snap={snap}
        style={{
          position: 'absolute',
          left: '0',
          right: '0',
          bottom: '0',
          height,
          maxHeight: height,
          backgroundColor: cssVar('surface.elevated'),
          borderTopLeftRadius: '16px',
          borderTopRightRadius: '16px',
          paddingLeft: '16px',
          paddingRight: '16px',
          paddingBottom: '16px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <LynxView
          data-lynx-resizable-sheet="grabber"
          accessibility-role="button"
          accessibility-label={lynxT(locale, 'lynx.sheet.grabber')}
          bindtap={() => setSnap((prev) => toggleLynxMobileSheetSnap(prev))}
          bindtouchstart={(event) => {
            dragStartY.current = readTouchY(event);
          }}
          bindtouchmove={(event) => {
            const start = dragStartY.current;
            const y = readTouchY(event);
            if (start == null || y == null) return;
            if (shouldDismissLynxMobileSheetDrag(y - start)) {
              dragStartY.current = null;
              onClose();
            }
          }}
          bindtouchend={() => {
            dragStartY.current = null;
          }}
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            paddingTop: '10px',
            paddingBottom: '8px',
            flexShrink: 0,
          }}
        >
          <LynxView
            data-lynx-resizable-sheet="grabber-pill"
            style={{
              width: '44px',
              height: '6px',
              borderRadius: '999px',
              backgroundColor: cssVar('surface.mutedForeground'),
              opacity: 0.55,
            }}
          />
        </LynxView>

        <LynxView
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '12px',
            flexShrink: 0,
          }}
        >
          <LynxText
            style={{
              color: cssVar('surface.foreground'),
              fontWeight: '700',
              fontSize: '18px',
              flexGrow: 1,
            }}
          >
            {title ?? ariaLabel}
          </LynxText>
          {trailing != null ? (
            <LynxView data-lynx-resizable-sheet="trailing" style={{ flexShrink: 0 }}>
              {trailing}
            </LynxView>
          ) : (
            <LynxView
              bindtap={onClose}
              accessibility-role="button"
              accessibility-label={lynxT(locale, 'lynx.sheet.close')}
              data-lynx-resizable-sheet="close"
            >
              <LynxText style={{ color: cssVar('primary.base') }}>
                {lynxT(locale, 'lynx.sheet.close')}
              </LynxText>
            </LynxView>
          )}
        </LynxView>

        <LynxView
          data-lynx-resizable-sheet="body"
          style={{ flexGrow: 1, minHeight: '0', display: 'flex', flexDirection: 'column' }}
        >
          {children}
        </LynxView>
      </LynxView>
    </LynxView>
  );
}
