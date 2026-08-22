import { handleCapgoOtaCheck } from '../../../lib/ota-check.js';

export async function onRequest({ request }) {
  return handleCapgoOtaCheck(request);
}
