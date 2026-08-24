import { useI18n } from '@/lib/i18n';
import {
  resolveManagedSshBootstrapErrorCode,
  sshBootstrapErrorGuidanceKey,
  sshBootstrapErrorTitleKey,
} from '@/lib/desktopSshBootstrapError';
import { cn } from '@/lib/utils';

export function SshBootstrapErrorNotice({
  errorCode,
  detail,
  className,
}: {
  errorCode?: string | null;
  detail?: string | null;
  className?: string;
}) {
  const { t } = useI18n();
  const code = resolveManagedSshBootstrapErrorCode(errorCode, detail);
  return (
    <div className={cn('space-y-1', className)}>
      <p className="typography-ui-label text-[var(--status-error)]">{t(sshBootstrapErrorTitleKey(code))}</p>
      <p className="typography-meta text-muted-foreground">{t(sshBootstrapErrorGuidanceKey(code))}</p>
    </div>
  );
}
