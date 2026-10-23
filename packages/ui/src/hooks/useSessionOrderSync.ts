import React from 'react';
import { useSessionOrderQuery, saveSessionOrder } from '@/queries/sessionOrderQueries';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';

/** Server snapshot owns order; import legacy local scopes only if absent on the Host. */
export function useSessionOrderSync() {
  const query = useSessionOrderQuery();
  const imported = React.useRef(new Set<string>());
  const transport = getRuntimeTransportIdentity();
  React.useEffect(() => {
    if (!query.data) return;
    const local = useSessionFoldersStore.getState();
    for (const [scope, order] of Object.entries(local.sessionOrderByScope)) {
      const importKey = `${transport}:${scope}`;
      if (Object.hasOwn(query.data.sessionOrderByScope, scope) || imported.current.has(importKey)
        || local.isSessionOrderPending(scope)) continue;
      imported.current.add(importKey);
      void saveSessionOrder(scope, order, local.sessionOrderActivityByScope[scope] ?? {}, true)
        .catch(() => { imported.current.delete(importKey); });
    }
    local.applySessionOrderSnapshot(query.data);
  }, [query.data, transport]);
}
