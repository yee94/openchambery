import { timingSafeEqual } from 'node:crypto';

export const SCHEDULED_TASK_SKILL_PATH = '/api/yuri/session-skills/scheduled-task';
export const SCHEDULED_TASK_SKILL_KEY = 'yuri.scheduled-task';

// The shared service credential is already owned by the local OS user. It is
// accepted only on this bridge, never as browser/client authentication.
export const authorizeScheduledTaskSkillRequest = (req, authHeaders) => {
  if (req.method !== 'POST' || req.headers?.origin) return false;
  const address = req.socket?.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false;
  const expected = authHeaders?.Authorization;
  const provided = req.headers?.authorization;
  if (typeof expected !== 'string' || !expected.startsWith('Basic ') || typeof provided !== 'string') return false;
  const a = Buffer.from(expected), b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
};
