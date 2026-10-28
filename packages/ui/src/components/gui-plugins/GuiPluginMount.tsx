import React from 'react';
import { useEvent } from '@reactuses/core';
import type { useGuiPlugins } from '@/lib/gui-plugins/react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';

type Host = NonNullable<ReturnType<typeof useGuiPlugins>['host']>;

/** React owns this empty container; the host exclusively owns its descendants. */
export function GuiPluginMount({ host, contributionKey, kind, revision, fallback }: {
  host: Host;
  contributionKey: string;
  kind: 'panel' | 'settings';
  revision?: string;
  fallback?: React.ReactNode;
}) {
  const { t } = useI18n();
  const container = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<{ cause: unknown } | null>(null);
  const deferred = fallback != null;
  const [pending, setPending] = React.useState(deferred);
  const reportCleanupError = useEvent((cause: unknown) => {
    toast.error(cause instanceof Error ? cause.message : t('guiPlugins.error'));
  });

  React.useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    setError(null);
    setPending(deferred);
    let dispose: (() => void) | undefined;
    let cancelled = false;
    let frame = 0;
    const mount = () => {
      if (cancelled) return;
      try {
        dispose = kind === 'panel'
          ? host.mountPanel(contributionKey, node)
          : host.mountSettings(contributionKey, node);
      } catch (cause) {
        node.replaceChildren();
        setError({ cause });
      } finally {
        setPending(false);
      }
    };
    if (deferred) {
      // A single animation frame still runs before paint. Leave a paint opportunity
      // for the fallback before running arbitrary synchronous plugin render code.
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(mount); });
    } else {
      mount();
    }
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      try {
        dispose?.();
      } catch (cause) {
        reportCleanupError(cause);
      } finally {
        node.replaceChildren();
      }
    };
  }, [host, contributionKey, kind, revision, deferred, reportCleanupError]);

  return (
    <div className={`relative flex flex-1 flex-col ${pending ? 'min-h-[240px]!' : 'min-h-0'}`}>
      {error ? <div role="alert" className="p-3 text-[var(--status-error)]">{error.cause instanceof Error ? error.cause.message : t('guiPlugins.error')}</div> : null}
      <div ref={container} className="min-h-0 flex-1 overflow-auto" data-gui-plugin-mount={kind} />
      {pending ? <div className="absolute inset-0 flex">{fallback}</div> : null}
    </div>
  );
}
