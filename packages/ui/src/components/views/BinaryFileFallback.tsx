import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { isDesktopLocalOriginActive, openDesktopPath } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';

export function BinaryFileFallback({ path }: { path: string }) {
  const { files, runtime } = useRuntimeAPIs();
  const { t } = useI18n();
  const [pending, setPending] = React.useState(false);
  const canOpenLocally = runtime.isDesktop && isDesktopLocalOriginActive();

  const performAction = async (action: () => Promise<void>) => {
    setPending(true);
    try {
      await action();
    } catch {
      toast.error(t('sidebarFilesTree.toast.operationFailed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex h-full min-h-48 items-center justify-center p-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-4">
        <p className="typography-ui text-muted-foreground">{t('filesView.binary.description')}</p>
        <div className="flex flex-wrap justify-center gap-2">
          {canOpenLocally && (
            <Button disabled={pending} onClick={() => void performAction(async () => {
              if (!await openDesktopPath(path)) throw new Error('System open failed');
            })}>
              {t('filesView.binary.openSystemApp')}
            </Button>
          )}
          {files.downloadFile && (
            <Button disabled={pending} onClick={() => void performAction(() => files.downloadFile!(path))}>
              {t('sidebarFilesTree.menu.save')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
