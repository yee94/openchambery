import { handleUpdateCheck } from '../../../lib/update-check.js';

export async function onRequest({ request }) {
  return handleUpdateCheck(request);
}
