import { expect, test } from 'bun:test';
import { isMessageQueueRoute } from './messageQueueRoute';

test('identifies only message queue server routes', () => {
  expect(isMessageQueueRoute('/api/yuri/message-queue')).toBe(true);
  expect(isMessageQueueRoute('/api/yuri/message-queue/worktrees/order')).toBe(true);
  expect(isMessageQueueRoute('/api/yuri/tunnel/status')).toBe(false);
});
