export const config = { runtime: 'edge' };

import { handleUpdateCheck } from '../../../lib/update-check.js';

export default async function handler(request) {
  return handleUpdateCheck(request);
}
