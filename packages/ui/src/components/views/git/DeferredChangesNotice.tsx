import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

/**
 * 超大变更集降级入口：变更数超过阈值时不自动渲染列表，改为展示
 * staged/unstaged 计数概要和"加载更改"按钮，由用户点击后再做排序/分组/建树。
 */
export const DeferredChangesNotice: React.FC<{
  stagedCount: number;
  unstagedCount: number;
  onLoad: () => void;
}> = ({ stagedCount, unstagedCount, onLoad }) => {
  const { t } = useI18n();

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <Icon name="loader-4" className="size-5 text-muted-foreground" />
      <div className="flex max-w-sm flex-col items-center gap-1">
        <p className="typography-meta text-muted-foreground">
          {t('gitView.changes.deferredStagedCount', { count: stagedCount })}
          {' · '}
          {t('gitView.changes.deferredUnstagedCount', { count: unstagedCount })}
        </p>
        <p className="typography-meta text-muted-foreground">
          {t('gitView.changes.deferredHint')}
        </p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={onLoad}>
        <Icon name="refresh" className="size-3.5" />
        {t('gitView.changes.deferredLoadAction')}
      </Button>
    </div>
  );
};
