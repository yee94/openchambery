import type { GitStatus } from '@/lib/api/types';

/**
 * 超大变更集的降级入口由服务端决定：`GitStatus.oversized` 是服务端在
 * 变更文件数超过其自有阈值时下发的标记（此时 diffStats 一并省略）。
 * 客户端不做本地阈值判断，服务端调整阈值时这里零改动自动跟随。
 * 点击"加载更改"后由调用方用本地 loaded 状态解除降级。
 */
export const isDeferredGitChangesStatus = (status: GitStatus | null | undefined): boolean => {
  if (!status) return false;
  return status.oversized === true;
};
