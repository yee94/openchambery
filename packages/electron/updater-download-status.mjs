/**
 * Snapshot of desktop update download state for renderer UI.
 * Pure helper so dialog open / check paths can show progress for idle downloads.
 */
export const getUpdateDownloadSnapshot = ({
  pendingUpdate = null,
  downloadInFlight = false,
  progress = null,
} = {}) => {
  const downloading = downloadInFlight === true;
  const downloaded = pendingUpdate?.downloaded === true;
  const progressSnapshot =
    downloading && progress && typeof progress === 'object'
      ? {
          downloaded: typeof progress.downloaded === 'number' ? progress.downloaded : 0,
          ...(typeof progress.total === 'number' ? { total: progress.total } : {}),
        }
      : null;

  return {
    downloading,
    downloaded,
    progress: progressSnapshot,
  };
};
