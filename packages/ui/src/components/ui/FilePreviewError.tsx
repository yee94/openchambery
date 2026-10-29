import { Button } from '@/components/ui/button';
import { FilePreviewState } from '@/components/ui/FilePreviewState';
import { useI18n } from '@/lib/i18n';

export function FilePreviewError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useI18n();

  return (
    <FilePreviewState illustration={
        <svg viewBox="0 0 240 160" fill="none" aria-hidden="true" className="h-20 w-30 max-w-full shrink-0 text-muted-foreground">
          <rect x="24" y="16" width="192" height="128" rx="14" fill="var(--surface-muted)" />
          <rect x="40" y="32" width="160" height="96" rx="8" stroke="currentColor" strokeOpacity="0.3" strokeDasharray="4 5" />
          <circle cx="86" cy="62" r="10" fill="currentColor" opacity="0.15" />
          <path d="m52 116 42-39 26 24 25-31 43 46" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="177" cy="119" r="21" fill="var(--surface-elevated)" stroke="var(--interactive-border)" />
          <path d="M177 109v12m0 6v1" stroke="var(--status-error)" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
    }>
        <div role="alert" className="w-full min-w-0 space-y-2">
          <p className="typography-ui-label text-foreground">{t('filesView.error.previewUnavailable')}</p>
          <p className="typography-meta whitespace-pre-wrap break-words text-muted-foreground [overflow-wrap:anywhere]">{message}</p>
        </div>
        {onRetry ? <Button size="sm" onClick={onRetry}>{t('contextPanel.preview.actions.retry')}</Button> : null}
    </FilePreviewState>
  );
}
