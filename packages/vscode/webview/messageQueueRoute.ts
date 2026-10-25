export const isMessageQueueRoute = (pathname: string): boolean => (
  pathname.replace(/\/+$/, '') === '/api/yuri/message-queue'
  || pathname.startsWith('/api/yuri/message-queue/')
);
