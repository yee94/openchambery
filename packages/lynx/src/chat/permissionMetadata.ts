/**
 * Cap PermissionCard metadata → plain Lynx text (no DOM / react-dom / WorkerHighlightedCode).
 * Source: packages/ui PermissionCard.tsx + types/permission.ts metadata shape.
 */

export type LynxPermissionMetadataLine = {
  /** Short label (Cap JsonSummaryView / i18n spirit). */
  label: string;
  /** Plain text body; may be multi-line for command/diff/content. */
  value: string;
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const getMeta = (metadata: Record<string, unknown>, key: string, fallback = ''): string => {
  const val = metadata[key];
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return fallback;
};

const getMetaNum = (metadata: Record<string, unknown>, key: string): number | undefined => {
  const val = metadata[key];
  return typeof val === 'number' ? val : undefined;
};

const getMetaBool = (metadata: Record<string, unknown>, key: string): boolean => Boolean(metadata[key]);

/** Cap PermissionCard normalizeMetadataKey. */
export const normalizeLynxPermissionMetadataKey = (key: string): string => {
  if (key === 'filepath' || key === 'file_path') return 'filePath';
  if (key === 'parentDir' || key === 'parent_dir') return 'parentDirectory';
  return key;
};

/** Cap JsonSummaryView formatKey. */
export const formatLynxPermissionMetadataLabel = (key: string): string => key
  .replace(/([A-Z])/g, ' $1')
  .replace(/[_-]/g, ' ')
  .replace(/^./, (character) => character.toUpperCase());

export const getLynxPermissionToolKind = (permissionName: string): 'bash' | 'edit' | 'write' | 'webfetch' | 'generic' => {
  const tool = permissionName.toLowerCase();
  if (tool === 'bash' || tool === 'shell' || tool === 'cmd' || tool === 'terminal' || tool === 'shell_command') {
    return 'bash';
  }
  if (tool === 'edit' || tool === 'multiedit' || tool === 'str_replace' || tool === 'str_replace_based_edit_tool') {
    return 'edit';
  }
  if (tool === 'write' || tool === 'create' || tool === 'file_write') {
    return 'write';
  }
  if (tool === 'webfetch' || tool === 'fetch' || tool === 'curl' || tool === 'wget') {
    return 'webfetch';
  }
  return 'generic';
};

export const getLynxPermissionToolDisplayName = (permissionName: string): string => {
  const kind = getLynxPermissionToolKind(permissionName);
  if (kind === 'generic') return permissionName;
  return kind;
};

const stringifyPlain = (value: unknown, maxLen = 4000): string => {
  if (value == null) return '';
  if (typeof value === 'string') {
    return value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  } catch {
    return String(value);
  }
};

const displayMetadata = (metadata: Record<string, unknown>): Record<string, unknown> => (
  Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => key !== 'always')
      .map(([key, value]) => [normalizeLynxPermissionMetadataKey(key), value]),
  )
);

/**
 * Cap PermissionCard renderToolContent → plain text lines for Lynx.
 */
export const formatLynxPermissionMetadataLines = (input: {
  permission: string;
  metadata?: Record<string, unknown> | null;
}): LynxPermissionMetadataLine[] => {
  const metadata = asRecord(input.metadata);
  const kind = getLynxPermissionToolKind(input.permission);
  const lines: LynxPermissionMetadataLine[] = [];

  if (kind === 'bash') {
    const description = getMeta(metadata, 'description');
    const workingDir = getMeta(metadata, 'cwd')
      || getMeta(metadata, 'working_directory')
      || getMeta(metadata, 'directory')
      || getMeta(metadata, 'path');
    const timeout = getMetaNum(metadata, 'timeout');
    const command = getMeta(metadata, 'command') || getMeta(metadata, 'cmd') || getMeta(metadata, 'script');
    if (description) lines.push({ label: 'Description', value: description });
    if (workingDir) lines.push({ label: 'Working directory', value: workingDir });
    if (timeout != null) lines.push({ label: 'Timeout', value: `${timeout}ms` });
    if (command) lines.push({ label: 'Command', value: command });
    return lines;
  }

  if (kind === 'edit') {
    const filePath = getMeta(metadata, 'path')
      || getMeta(metadata, 'file_path')
      || getMeta(metadata, 'filename')
      || getMeta(metadata, 'filePath');
    const changes = getMeta(metadata, 'changes') || getMeta(metadata, 'diff');
    const replaceAll = getMetaBool(metadata, 'replace_all') || getMetaBool(metadata, 'replaceAll');
    if (replaceAll) lines.push({ label: 'Replace all', value: 'true' });
    if (filePath) lines.push({ label: 'File Path', value: filePath });
    if (changes) lines.push({ label: 'Diff', value: stringifyPlain(changes) });
    return lines;
  }

  if (kind === 'write') {
    const filePath = getMeta(metadata, 'path')
      || getMeta(metadata, 'file_path')
      || getMeta(metadata, 'filename')
      || getMeta(metadata, 'filePath');
    const content = getMeta(metadata, 'content') || getMeta(metadata, 'text') || getMeta(metadata, 'data');
    if (filePath) lines.push({ label: 'File Path', value: filePath });
    if (content) lines.push({ label: 'Content', value: stringifyPlain(content) });
    return lines;
  }

  if (kind === 'webfetch') {
    const url = getMeta(metadata, 'url') || getMeta(metadata, 'uri') || getMeta(metadata, 'endpoint');
    const method = getMeta(metadata, 'method') || 'GET';
    const headers = metadata.headers && typeof metadata.headers === 'object'
      ? metadata.headers as Record<string, unknown>
      : undefined;
    const body = metadata.body ?? metadata.data ?? metadata.payload;
    const timeout = getMetaNum(metadata, 'timeout');
    const format = getMeta(metadata, 'format') || getMeta(metadata, 'responseType');
    if (url) lines.push({ label: 'Request', value: `${method} ${url}` });
    if (headers && Object.keys(headers).length > 0) {
      lines.push({ label: 'Headers', value: stringifyPlain(headers) });
    }
    if (body != null && body !== '') {
      lines.push({ label: 'Body', value: stringifyPlain(body) });
    }
    if (timeout != null) lines.push({ label: 'Timeout', value: `${timeout}ms` });
    if (format) lines.push({ label: 'Response format', value: format });
    return lines;
  }

  const display = displayMetadata(metadata);
  for (const [key, value] of Object.entries(display)) {
    if (value == null) continue;
    lines.push({
      label: formatLynxPermissionMetadataLabel(key),
      value: stringifyPlain(value),
    });
  }
  return lines;
};

/** Single block string for tests / a11y. */
export const formatLynxPermissionMetadataText = (input: {
  permission: string;
  metadata?: Record<string, unknown> | null;
}): string => formatLynxPermissionMetadataLines(input)
  .map((line) => `${line.label}: ${line.value}`)
  .join('\n');
