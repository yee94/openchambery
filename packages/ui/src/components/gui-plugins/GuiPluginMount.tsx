import React from 'react';
import { useEvent } from '@reactuses/core';
import type { useGuiPlugins } from '@/lib/gui-plugins/react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';

type Host = NonNullable<ReturnType<typeof useGuiPlugins>['host']>;

/** React owns this empty container; the host exclusively owns its descendants. */
export function GuiPluginMount({ host, contributionKey, kind, revision }: {
  host: Host;
  contributionKey: string;
  kind: 'panel' | 'settings';
  revision?: string;
}) {
  const { t } = useI18n();
  const container = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<{ cause: unknown } | null>(null);
  const reportCleanupError = useEvent((cause: unknown) => {
    toast.error(cause instanceof Error ? cause.message : t('guiPlugins.error'));
  });

  React.useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    setError(null);
    let dispose: (() => void) | undefined;
    try {
      dispose = kind === 'panel'
        ? host.mountPanel(contributionKey, node)
        : host.mountSettings(contributionKey, node);
    } catch (cause) {
      node.replaceChildren();
      setError({ cause });
    }
    return () => {
      try {
        dispose?.();
      } catch (cause) {
        reportCleanupError(cause);
      } finally {
        node.replaceChildren();
      }
    };
  }, [host, contributionKey, kind, revision, reportCleanupError]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error ? <div role="alert" className="p-3 text-[var(--status-error)]">{error.cause instanceof Error ? error.cause.message : t('guiPlugins.error')}</div> : null}
      <div ref={container} className="min-h-0 flex-1 overflow-auto" data-gui-plugin-mount={kind} />
    </div>
  );
}
