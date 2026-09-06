/**
 * Cap Dialog / DialogContent spirit — scrim + centered panel modal.
 * Overlay only; never nest under GlassChrome. Not MobileResizableSheet.
 * Mount via LynxDialogPortal at shell root (full-screen), not Changes relative.
 */
import type { ReactNode } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxText, LynxView } from '../lynx-elements';
import { cssVar } from '../theme/tokens';
import {
  LYNX_CENTERED_DIALOG,
  shouldAllowLynxCenteredDialogDismiss,
} from './centeredDialog';

export type LynxCenteredDialogProps = {
  locale: string;
  open: boolean;
  /** DialogTitle spirit. */
  title: string;
  /** DialogDescription spirit (optional). */
  description?: string;
  /** Extra body (e.g. path monospace). */
  children?: ReactNode;
  /** DialogFooter actions. */
  footer: ReactNode;
  ariaLabel: string;
  onClose: () => void;
  /** When true, Cap blocks scrim/outside dismiss. */
  busy?: boolean;
};

/**
 * Centered modal: dimmed scrim + max-w-md panel.
 * Returns null when closed.
 */
export function LynxCenteredDialog({
  locale,
  open,
  title,
  description,
  children,
  footer,
  ariaLabel,
  onClose,
  busy = false,
}: LynxCenteredDialogProps) {
  if (!open) return null;

  const allowDismiss = shouldAllowLynxCenteredDialogDismiss(busy);

  return (
    <LynxView
      data-lynx-centered-dialog="root"
      data-lynx-centered-dialog-placement={LYNX_CENTERED_DIALOG.placement}
      style={{
        position: 'absolute',
        left: '0',
        right: '0',
        top: '0',
        bottom: '0',
        zIndex: LYNX_CENTERED_DIALOG.zIndex,
      }}
      accessibility-label={ariaLabel}
    >
      {/* Cap overlay: scrim is also the flex centering host (RN-friendly). */}
      <LynxView
        data-lynx-centered-dialog="scrim"
        bindtap={() => {
          if (allowDismiss) onClose();
        }}
        accessibility-role="button"
        accessibility-label={lynxT(locale, 'lynx.sheet.close')}
        style={{
          position: 'absolute',
          left: '0',
          right: '0',
          top: '0',
          bottom: '0',
          backgroundColor: LYNX_CENTERED_DIALOG.scrim,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: `${LYNX_CENTERED_DIALOG.containerPaddingPx}px`,
        }}
      >
        <LynxView
          data-lynx-centered-dialog="panel"
          // Absorb taps so footer/title do not dismiss via scrim.
          bindtap={() => {}}
          style={{
            width: '100%',
            maxWidth: `${LYNX_CENTERED_DIALOG.maxWidthPx}px`,
            backgroundColor: cssVar('surface.background'),
            borderRadius: `${LYNX_CENTERED_DIALOG.radiusPx}px`,
            padding: `${LYNX_CENTERED_DIALOG.panelPaddingPx}px`,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <LynxText
            data-lynx-centered-dialog="title"
            style={{
              color: cssVar('surface.foreground'),
              fontSize: '16px',
              fontWeight: '700',
              marginBottom: description || children ? '8px' : '16px',
            }}
          >
            {title}
          </LynxText>
          {description ? (
            <LynxText
              data-lynx-centered-dialog="description"
              style={{
                color: cssVar('surface.mutedForeground'),
                fontSize: '13px',
                marginBottom: children ? '8px' : '16px',
              }}
            >
              {description}
            </LynxText>
          ) : null}
          {children}
          <LynxView
            data-lynx-centered-dialog="footer"
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
              marginTop: children || description ? '8px' : '0',
            }}
          >
            {footer}
          </LynxView>
        </LynxView>
      </LynxView>
    </LynxView>
  );
}

export type LynxCenteredDialogActionProps = {
  label: string;
  onTap: () => void;
  /** Cap destructive: status.error fill + status.onError text (not `#fff`). */
  destructive?: boolean;
  disabled?: boolean;
};

/** Compact DialogFooter action (Cancel / destructive confirm). */
export function LynxCenteredDialogAction({
  label,
  onTap,
  destructive = false,
  disabled = false,
}: LynxCenteredDialogActionProps) {
  return (
    <LynxView
      bindtap={() => {
        if (!disabled) onTap();
      }}
      accessibility-role="button"
      accessibility-label={label}
      style={{
        padding: '8px 12px',
        marginLeft: '8px',
        marginBottom: '4px',
        borderRadius: '8px',
        opacity: disabled ? 0.5 : 1,
        backgroundColor: destructive ? cssVar('status.error') : cssVar('surface.elevated'),
      }}
    >
      <LynxText
        style={{
          color: destructive ? cssVar('status.onError') : cssVar('surface.foreground'),
          fontWeight: '600',
          fontSize: '13px',
        }}
      >
        {label}
      </LynxText>
    </LynxView>
  );
}
