import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { GitStatus } from '@/lib/api/types';

/**
 * 超大变更集的降级入口优先由服务端决定：`GitStatus.oversized` 是服务端在
 * 变更文件数超过其自有阈值时下发的标记（此时 diffStats 一并省略）。
 * 服务端声明（true / false）永远优先，客户端不复核服务器阈值。
 * 点击"加载更改"后由调用方用本地 loaded 状态解除降级。
 */

/**
 * 旧 Host fallback 阈值：仅当服务器未下发 `oversized` 字段（旧版 Web Host
 * 不认识该契约）时作为渲染保护的最后防线。它不是服务端
 * GIT_STATUS_DIFF_STATS_MAX_FILES 的副本 —— 新 Host 的声明永远优先，
 * 服务器调整阈值时正常路径零改动自动跟随。
 */
const LEGACY_HOST_DEFERRED_FILES_THRESHOLD = 5000;

const isVSCodeGitRuntime = (): boolean =>
  getRegisteredRuntimeAPIs()?.runtime?.isVSCode === true;

export const isDeferredGitChangesStatus = (status: GitStatus | null | undefined): boolean => {
  if (!status) return false;
  if (status.oversized !== undefined) {
    return status.oversized === true;
  }
  // 字段缺失 = 旧 Host（或 VS Code 本地 git）。VS Code 的 git status 由
  // Extension Host 本地计算、从不算 diffStats，没有重路径可降级，保持直渲染。
  if (isVSCodeGitRuntime()) return false;
  return (status.files?.length ?? 0) > LEGACY_HOST_DEFERRED_FILES_THRESHOLD;
};
