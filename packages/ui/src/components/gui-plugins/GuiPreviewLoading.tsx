import { Button } from '@/components/ui/button';
import { FilePreviewState } from '@/components/ui/FilePreviewState';
import { useI18n } from '@/lib/i18n';
import './gui-preview-loading.css';

export function GuiPreviewLoading({ onViewSource }: { onViewSource: () => void }) {
  const { t } = useI18n();

  return (
    <div className="flex h-full min-h-[240px]! min-w-0 flex-1" data-gui-preview-loading>
      <FilePreviewState illustration={
      <svg className="size-20 shrink-0 text-muted-foreground" viewBox="0 0 80 80" fill="none" aria-hidden="true" focusable="false">
        <path d="M23 9h23l13 13v43a6 6 0 0 1-6 6H23a6 6 0 0 1-6-6V15a6 6 0 0 1 6-6Z" stroke="currentColor" strokeWidth="1.5" opacity=".45" />
        <path d="M46 9v10a3 3 0 0 0 3 3h10" stroke="currentColor" strokeWidth="1.5" opacity=".45" />
        <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="yuri-preview-loading-lines">
          <path d="M28 35h20" />
          <path d="M28 45h20" />
          <path d="M28 55h12" />
        </g>
      </svg>
      }>
      <div role="status" aria-live="polite" className="max-w-sm space-y-1.5 break-words">
        <p className="typography-ui-label font-medium text-foreground">{t('guiPlugins.preview.loadingTitle')}</p>
        <p className="typography-meta text-muted-foreground">{t('guiPlugins.preview.loadingDescription')}</p>
      </div>
      <Button variant="ghost" size="sm" className="focus-visible:bg-interactive-hover" onClick={onViewSource}>{t('guiPlugins.preview.viewSource')}</Button>
      </FilePreviewState>
    </div>
  );
}
