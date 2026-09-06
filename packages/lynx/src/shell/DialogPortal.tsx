/**
 * Shell-root dialog portal — Cap DialogPortal spirit without DOM createPortal.
 * Provider hosts overlay at LynxShellApp; LynxDialogPortal teleports children.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { LynxView } from '../lynx-elements';
import { LYNX_SHELL_DIALOG_PORTAL } from './dialogPortal';

type LynxShellDialogPortalContextValue = {
  setPortalContent: (node: ReactNode | null) => void;
};

const LynxShellDialogPortalContext = createContext<LynxShellDialogPortalContextValue | null>(
  null,
);

export type LynxShellDialogPortalProviderProps = {
  children: ReactNode;
};

/**
 * Wraps shell page content and paints a full-screen overlay host as the last
 * sibling (above dock / sheet chrome).
 */
export function LynxShellDialogPortalProvider({ children }: LynxShellDialogPortalProviderProps) {
  const [portalContent, setPortalContent] = useState<ReactNode | null>(null);
  const value = useMemo(() => ({ setPortalContent }), []);

  return (
    <LynxShellDialogPortalContext.Provider value={value}>
      {children}
      {portalContent ? (
        <LynxView
          data-lynx-dialog-portal="host"
          data-lynx-dialog-portal-mount={LYNX_SHELL_DIALOG_PORTAL.mountPoint}
          data-lynx-dialog-portal-placement={LYNX_SHELL_DIALOG_PORTAL.placement}
          style={{
            position: 'absolute',
            left: '0',
            right: '0',
            top: '0',
            bottom: '0',
            zIndex: LYNX_SHELL_DIALOG_PORTAL.zIndex,
          }}
        >
          {portalContent}
        </LynxView>
      ) : null}
    </LynxShellDialogPortalContext.Provider>
  );
}

export type LynxDialogPortalProps = {
  children: ReactNode;
};

/**
 * Teleport `children` into the shell-root overlay host.
 * When no provider is present (unit trees), renders children in place.
 */
export function LynxDialogPortal({ children }: LynxDialogPortalProps) {
  const ctx = useContext(LynxShellDialogPortalContext);

  useEffect(() => {
    if (!ctx) return;
    ctx.setPortalContent(children);
    return () => {
      ctx.setPortalContent(null);
    };
  }, [ctx, children]);

  if (!ctx) {
    return <>{children}</>;
  }

  // Content is painted by the shell host.
  return null;
}

/** Optional hook for callers that need to know portal is available. */
export function useLynxShellDialogPortal(): LynxShellDialogPortalContextValue | null {
  return useContext(LynxShellDialogPortalContext);
}

/** Test helper — clear portal content. */
export function useLynxShellDialogPortalSetter(): (node: ReactNode | null) => void {
  const ctx = useContext(LynxShellDialogPortalContext);
  return useCallback((node: ReactNode | null) => {
    ctx?.setPortalContent(node);
  }, [ctx]);
}
