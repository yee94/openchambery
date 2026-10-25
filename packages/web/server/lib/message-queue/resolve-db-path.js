import path from 'node:path';

export const resolveMessageQueueDbPath = ({ messageQueueDbPath } = {}, yuriDataDir) => {
  if (messageQueueDbPath === null) return null;
  if (typeof messageQueueDbPath === 'string' && messageQueueDbPath.trim()) return messageQueueDbPath;
  if (typeof yuriDataDir !== 'string' || !yuriDataDir.trim()) return null;
  return path.join(yuriDataDir, 'message-queue.sqlite');
};
