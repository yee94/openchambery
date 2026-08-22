import { handleMobileUpdateCheck } from '../../../../lib/ota-check.js';

export async function onRequest({ request }) {
  return handleMobileUpdateCheck(request);
}
