/* eslint-disable react-refresh/only-export-components */
import React from 'react';

export type MobileAppActions = {
  /** Open the Changes surface as a modal and (optionally) navigate it to a specific diff. */
  openChanges: (options?: { diffPath?: string | null; staged?: boolean; targetLine?: number }) => void;
  /** Open every exact file patch selected from one edit/apply_patch tool row. */
  openToolDiff: (options: {
    diffPath: string;
    patches: ReadonlyArray<{ path: string; patch: string }>;
    targetLine?: number;
  }) => void;
  /** Open every diff from the owning turn in a mobile review sheet. */
  openTurnDiff: (messageId?: string) => void;
  /** Open the Files surface as a modal. */
  openFiles: () => void;
  /** Open the Settings surface as a modal. */
  openSettings: (section?: string) => void;
};

const DedicatedMobileAppContext = React.createContext<MobileAppActions | null>(null);

export const DedicatedMobileAppProvider: React.FC<{
  actions: MobileAppActions;
  children: React.ReactNode;
}> = ({ actions, children }) => (
  <DedicatedMobileAppContext.Provider value={actions}>{children}</DedicatedMobileAppContext.Provider>
);

/**
 * Returns the dedicated mobile app's surface-opening actions, or null when
 * not inside the dedicated mobile root. Components living in shared chat /
 * input code can use this to route navigation to mobile-native surfaces
 * (e.g. open the Changes diff for a file from PendingChangesBar) instead of
 * desktop sidebars.
 */
export const useMobileAppActions = (): MobileAppActions | null => React.useContext(DedicatedMobileAppContext);
