/** A loopback URL alone is not ownership: external services and SSH forwards are excluded. */
export function trustedGuiPluginClient({ managed, shared, ready, url, client }) {
  let local = false;
  try {
    const parsed = new URL(url);
    local = ['http:', 'https:'].includes(parsed.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)
      && !parsed.username && !parsed.password;
  } catch { /* Missing or malformed endpoint is not a trusted source. */ }
  if (!local || (!managed && !shared)) {
    throw Object.assign(new Error('Native GUI source is not locally managed'), { code: 'GUI_PLUGIN_UNTRUSTED_SOURCE' });
  }
  if (!ready) throw Object.assign(new Error('Local GUI service is unavailable'), { code: 'GUI_PLUGIN_UNAVAILABLE' });
  return client();
}
