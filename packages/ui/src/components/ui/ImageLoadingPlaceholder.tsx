import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import './image-loading.css';

/** Dotted shimmer canvas inspired by https://aicss.dev/components/image-generation. */
export function ImageLoadingPlaceholder({ className }: { className?: string }) {
  const { t } = useI18n();
  return <span className={cn('oc-image-loading', className)} role="status" aria-label={t('chat.fileAttachment.image.loading')} />;
}
