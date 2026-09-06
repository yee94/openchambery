/** Cap `createProjectIdFromPath` — stable id from normalized absolute path. */
export const createProjectIdFromPath = (projectPath: string): string => {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/g, '').trim();
  if (!normalized) return '';

  const data = new TextEncoder().encode(normalized);
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }

  const encoded =
    typeof btoa === 'function'
      ? btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
      : Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

  return `path_${encoded}`;
};
