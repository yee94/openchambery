import type { GitStatus } from '@/lib/api/types';

/**
 * 当工作区变更文件数超过该阈值时，变更列表与派生数据（排序/分组/树/预取）
 * 不再自动渲染，改为展示一个"点击加载"的降级入口，由用户显式触发加载。
 * 该规模下全量排序 + 树构建 + 行扁平化会阻塞主线程数秒。
 */
export const GIT_CHANGES_DEFERRED_THRESHOLD = 2000;

/** 状态是否应进入延迟加载（deferred）模式。空/无状态不降级。 */
export const isDeferredGitChangesStatus = (status: GitStatus | null | undefined): boolean => {
  if (!status) return false;
  return (status.files?.length ?? 0) > GIT_CHANGES_DEFERRED_THRESHOLD;
};
