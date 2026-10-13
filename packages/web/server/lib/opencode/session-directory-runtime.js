import fs from 'node:fs';

const normalize = (value) => typeof value === 'string' && value.trim()
  ? value.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '/' : null;
const directoryOf = (session) => session?.location?.directory ?? session?.directory ?? session?.project?.worktree;

/** Host-only physical identity. Remote upstream paths must never touch local fs. */
export const createSessionDirectoryRuntime = ({
  getRuntimeUrl,
  realpath = fs.realpathSync.native,
  fetchFn = (...args) => globalThis.fetch(...args),
  now = Date.now,
} = {}) => {
  const cache = new Map();
  let scope = null;
  let local = false;
  const isLocal = () => {
    let runtime;
    try { runtime = getRuntimeUrl?.() ?? ''; } catch { return false; }
    if (runtime !== scope) {
      cache.clear();
      scope = runtime;
      try { local = !runtime || ['localhost', '127.0.0.1', '[::1]'].includes(new URL(runtime).hostname); }
      catch { local = false; }
    }
    return local;
  };
  const localPath = (value) => {
    const input = normalize(value);
    if (!input || !isLocal()) return null;
    const cached = cache.get(input);
    if (cached && cached.until > now()) return cached.path;
    let resolved = null;
    try { resolved = normalize(realpath(input)); } catch { /* Unmounted/missing paths retain lexical identity. */ }
    cache.delete(input);
    cache.set(input, { path: resolved, until: now() + (resolved ? 60_000 : 5_000) });
    if (cache.size > 256) cache.delete(cache.keys().next().value);
    return resolved;
  };
  const resolveDirectory = (value) => localPath(value) ?? normalize(value);
  const projectSession = (session) => {
    if (!session || typeof session !== 'object') return session;
    const directory = resolveDirectory(directoryOf(session));
    if (!directory || (session.directory === directory && (!session.location || session.location.directory === directory))) return session;
    return { ...session, directory, ...(session.location ? { location: { ...session.location, directory } } : {}) };
  };
  const projectEvent = (event) => {
    if (!event || typeof event !== 'object') return event;
    if (typeof event.directory === 'string' && event.directory !== 'global') {
      const directory = resolveDirectory(event.directory);
      if (directory !== event.directory) event = { ...event, directory };
    }
    if (event.payload) {
      const payload = projectEvent(event.payload);
      const directory = event.directory && event.directory !== 'global' ? resolveDirectory(event.directory) : event.directory;
      return payload === event.payload && directory === event.directory ? event : { ...event, payload, ...(directory ? { directory } : {}) };
    }
    if (typeof event.type !== 'string' || !/^session\.(created|updated|moved)(\.|$)/.test(event.type)) return event;
    const field = event.data ? 'data' : 'properties';
    const data = event[field];
    if (!data || typeof data !== 'object') return event;
    if (event.type === 'session.moved' && data.location?.directory) {
      return { ...event, [field]: { ...data, location: { ...data.location, directory: resolveDirectory(data.location.directory) } } };
    }
    if (data.info) return { ...event, [field]: { ...data, info: projectSession(data.info) } };
    return typeof data.id === 'string' ? { ...event, [field]: projectSession(data) } : event;
  };

  // v2 directory filters are lexical SQL equality. Query the owning project
  // instead, then retain only the same physical directory (not other worktrees).
  // This also finds old aliases absent from OpenChamber's bounded index.
  const fetchSessionList = async (input, init) => {
    const url = new URL(input);
    if (!['/api/session', '/session'].includes(url.pathname) || (init?.method && init.method !== 'GET')) return fetchFn(input, init);
    const requested = url.searchParams.get('directory');
    const target = requested && localPath(requested);
    if (!target || url.searchParams.has('project')) {
      return fetchFn(input, init);
    }
    if (!url.searchParams.has('cursor')) {
      const locationUrl = new URL(url);
      locationUrl.pathname = locationUrl.pathname.replace(/\/session\/?$/, '/location');
      locationUrl.search = '';
      locationUrl.searchParams.set('location[directory]', target);
      const response = await fetchFn(locationUrl, init);
      if (!response.ok) return response;
      const location = await response.json();
      if (typeof location?.project?.id !== 'string') throw new Error('Invalid OpenCode location payload');
      url.searchParams.set('project', location.project.id);
    }
    url.searchParams.delete('directory');
    init?.signal?.throwIfAborted();
    const response = await fetchFn(url, init);
    if (!response.ok) return response;
    const payload = await response.json();
    init?.signal?.throwIfAborted();
    const records = Array.isArray(payload) ? payload : payload?.data;
    if (!Array.isArray(records)) throw new Error('Invalid OpenCode session list payload');
    const sessions = records.filter((session) => session?.id && resolveDirectory(directoryOf(session)) === target)
      .map(projectSession);
    // Preserve the opaque upstream cursors in both directions. A filtered short
    // or empty page with a continuation is not an exhausted directory.
    const body = Array.isArray(payload) ? sessions : { ...payload, data: sessions };
    const headers = new Headers(response.headers);
    for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'etag']) headers.delete(name);
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(body), { status: response.status, headers });
  };
  return { isLocal, resolveDirectory, projectSession, projectEvent, fetchSessionList };
};
