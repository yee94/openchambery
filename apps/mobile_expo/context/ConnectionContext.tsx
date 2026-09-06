import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

import {
  ConnectionController,
  type ConnectionControllerState,
} from '@/lib/connectionController';
import { connectionStatusLabel } from '@/lib/i18n';

type ConnectionContextValue = {
  controller: ConnectionController;
  state: ConnectionControllerState;
  statusLabel: string | null;
};

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const controller = useMemo(() => new ConnectionController(), []);
  const [state, setState] = useState(controller.getState());

  useEffect(() => {
    const unsub = controller.subscribe(() => setState(controller.getState()));
    void controller.bootstrap();
    return unsub;
  }, [controller]);

  const statusLabel =
    controller.activeTransportKind != null
      ? connectionStatusLabel(controller.activeTransportKind)
      : null;

  const value = useMemo(
    () => ({ controller, state, statusLabel }),
    [controller, state, statusLabel],
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionContextValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error('useConnection requires ConnectionProvider');
  return ctx;
}
