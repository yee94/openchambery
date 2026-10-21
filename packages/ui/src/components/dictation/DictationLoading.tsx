import { useI18n } from '@/lib/i18n';
import styles from './DictationLoading.module.css';

export function DictationLoading({ decorative = false }: { decorative?: boolean }) {
    const { t } = useI18n();
    return <span data-dictation-loading className={styles.glyph}
        aria-hidden={decorative || undefined}
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : t('common.loading')}>
        <span className={styles.lens}>
            <span className={styles.shape} />
            <span className={styles.shape} />
            <span className={styles.shape} />
        </span>
    </span>;
}
