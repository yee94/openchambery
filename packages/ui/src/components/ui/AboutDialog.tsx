import React from 'react';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { getDesktopAppVersion } from '@/lib/desktopNative';
import { runtimeFetch } from '@/lib/runtime-fetch';

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const AboutDialog: React.FC<AboutDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const [version, setVersion] = React.useState<string | null>(null);
  const [openCodeVersion, setOpenCodeVersion] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;

    const fetchVersion = async () => {
      try {
        const response = await runtimeFetch('/api/system/info');
        if (response.ok) {
          const data = await response.json();
          if (typeof data.openchamberVersion === 'string' && data.openchamberVersion.trim()) {
            setVersion(data.openchamberVersion);
            return;
          }
        }
      } catch {
        // Fall back to the native shell version when the web server is unavailable.
      }

      setVersion(await getDesktopAppVersion());
    };

    void fetchVersion();
  }, [open]);

  React.useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const fetchOpenCodeVersion = async () => {
      try {
        const response = await runtimeFetch('/api/opencode/upgrade-status', {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const data = await response.json().catch(() => null) as null | { currentVersion?: unknown };
        const currentVersion = typeof data?.currentVersion === 'string' ? data.currentVersion.trim() : '';
        if (!cancelled && currentVersion) {
          setOpenCodeVersion(currentVersion);
        }
      } catch {
        // OpenCode version is best-effort in About.
      }
    };

    void fetchOpenCodeVersion();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const displayVersion = version;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs p-5">
        <div className="flex flex-col items-center gap-3 text-center">
          <OpenChamberLogo width={48} height={48} />

          <div className="space-y-1">
            <h2 className="text-lg font-semibold">OpenChamber</h2>
            <div className="space-y-0.5 typography-meta text-muted-foreground">
              {displayVersion && (
                <p>{t('aboutDialog.openChamberVersionLabel', { version: displayVersion })}</p>
              )}
              {openCodeVersion && (
                <p>{t('aboutDialog.openCodeVersionLabel', { version: openCodeVersion })}</p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-center">
            <a
              href="https://github.com/yee94/openchamber"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-meta text-muted-foreground hover:text-foreground transition-colors"
            >
              <Icon name="github-fill" className="h-4 w-4" />
              <span>GitHub</span>
            </a>
          </div>

          <p className="typography-micro text-muted-foreground/60">
            {t('aboutDialog.footerNote')}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
};
