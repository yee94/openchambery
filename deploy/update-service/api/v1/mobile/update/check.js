export const config = { runtime: 'edge' };

import { handleMobileUpdateCheck } from '../../../../lib/ota-check.js';

export default async function handler(request) {
  return handleMobileUpdateCheck(request);
}
