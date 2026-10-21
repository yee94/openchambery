import { useI18n } from '@/lib/i18n';
import styles from './DictationLoading.module.css';

export function DictationLoading({ decorative = false, size = 20 }: { decorative?: boolean; size?: number }) {
    const { t } = useI18n();
    return <span data-dictation-loading className={styles.glyph} style={{ width: size, height: size }}
        aria-hidden={decorative || undefined}
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : t('common.loading')}>
        <span className={styles.lens} style={{ transform: `scale(${size / 28})` }}>
            <span className={styles.shape} />
            <span className={styles.shape} />
            <span className={styles.shape} />
        </span>
    </span>;
}
