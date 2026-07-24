export type MobileSessionIndicator = 'question' | 'permission' | 'running' | 'completed-unread' | 'idle';

export const resolveMobileSessionIndicator = ({
  hasPendingQuestion,
  hasPendingPermission,
  running,
  unread,
}: {
  hasPendingQuestion: boolean;
  hasPendingPermission: boolean;
  running: boolean;
  unread: boolean;
}): MobileSessionIndicator => {
  if (hasPendingQuestion) return 'question';
  if (hasPendingPermission) return 'permission';
  if (running) return 'running';
  if (unread) return 'completed-unread';
  return 'idle';
};
