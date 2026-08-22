import { handleOtaProxyRequest } from '../../lib/ota-proxy.js';

export async function onRequest({ request }) {
  return handleOtaProxyRequest(request);
}
