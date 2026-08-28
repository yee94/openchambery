import { useI18n } from '@/lib/i18n';
import {
  resolveManagedSshBootstrapErrorCode,
  sshBootstrapErrorGuidanceKey,
  sshBootstrapErrorShowsRawDetail,
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
  const guidance = t(sshBootstrapErrorGuidanceKey(code));
  const raw = typeof detail === 'string' ? detail.trim() : '';
  const showDetail = sshBootstrapErrorShowsRawDetail(code) && Boolean(raw) && raw !== guidance;
  return (
    <div className={cn('space-y-1', className)}>
      <p className="typography-ui-label text-[var(--status-error)]">{t(sshBootstrapErrorTitleKey(code))}</p>
      <p className="typography-meta text-muted-foreground">{guidance}</p>
      {showDetail ? (
        <p className="typography-meta break-words text-muted-foreground">{raw}</p>
      ) : null}
    </div>
  );
}
