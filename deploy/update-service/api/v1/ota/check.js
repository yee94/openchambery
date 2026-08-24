export const config = { runtime: 'edge' };

import { handleCapgoOtaCheck } from '../../../lib/ota-check.js';

export default async function handler(request) {
  return handleCapgoOtaCheck(request);
}
