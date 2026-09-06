/**
 * Cap OpenChamberShare catalog / inbox contracts.
 * Exact instance+assistant routing metadata only — never server tokens.
 * App Group: group.com.yee94.openchamber
 */

export type ShareCatalogEntry = {
  serverInstanceID: string;
  assistantID: string;
  name: string;
  avatarSeed: string;
  avatarEmoji?: string;
  serverLabel: string;
  connectionKey: string;
  enabled: boolean;
  isDefaultShareTarget: boolean;
};

export type ShareAttachment = {
  stagedPath: string;
  originalName: string;
  mime: string;
  byteSize: number;
};

export type ShareEnvelope = {
  version: 1;
  operationID: string;
  serverInstanceID: string;
  assistantID: string;
  text?: string;
  attachments: ShareAttachment[];
  source: 'ios-share' | 'android-share';
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
};

export function parseShareCatalogEntry(raw: unknown): ShareCatalogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.serverInstanceID !== 'string' || !o.serverInstanceID.trim()) return null;
  if (typeof o.assistantID !== 'string' || !o.assistantID.trim()) return null;
  if (typeof o.name !== 'string' || !o.name.trim()) return null;
  if (typeof o.connectionKey !== 'string') return null;
  return {
    serverInstanceID: o.serverInstanceID.trim(),
    assistantID: o.assistantID.trim(),
    name: o.name.trim(),
    avatarSeed: typeof o.avatarSeed === 'string' ? o.avatarSeed : o.assistantID.trim(),
    avatarEmoji: typeof o.avatarEmoji === 'string' ? o.avatarEmoji : undefined,
    serverLabel: typeof o.serverLabel === 'string' ? o.serverLabel : '',
    connectionKey: o.connectionKey,
    enabled: o.enabled !== false,
    isDefaultShareTarget: o.isDefaultShareTarget === true,
  };
}

export function parseShareEnvelope(raw: unknown): ShareEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return null;
  if (typeof o.operationID !== 'string' || !o.operationID.trim()) return null;
  if (typeof o.serverInstanceID !== 'string' || !o.serverInstanceID.trim()) return null;
  if (typeof o.assistantID !== 'string' || !o.assistantID.trim()) return null;
  if (o.source !== 'ios-share' && o.source !== 'android-share') return null;
  if (!Number.isFinite(o.createdAt) || !Number.isFinite(o.expiresAt)) return null;
  const attachments = Array.isArray(o.attachments)
    ? o.attachments
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const a = item as Record<string, unknown>;
          if (typeof a.stagedPath !== 'string' || typeof a.originalName !== 'string') return null;
          if (typeof a.mime !== 'string' || !Number.isFinite(a.byteSize as number)) return null;
          return {
            stagedPath: a.stagedPath,
            originalName: a.originalName,
            mime: a.mime,
            byteSize: Number(a.byteSize),
          };
        })
        .filter((x): x is ShareAttachment => !!x)
    : [];
  return {
    version: 1,
    operationID: o.operationID.trim(),
    serverInstanceID: o.serverInstanceID.trim(),
    assistantID: o.assistantID.trim(),
    text: typeof o.text === 'string' ? o.text : undefined,
    attachments,
    source: o.source,
    createdAt: Number(o.createdAt),
    expiresAt: Number(o.expiresAt),
    consumedAt: Number.isFinite(o.consumedAt as number) ? Number(o.consumedAt) : undefined,
  };
}

/** Exact instance+assistant match, else default share target. */
export function resolveShareTarget(
  catalog: ShareCatalogEntry[],
  serverInstanceID?: string,
  assistantID?: string,
): ShareCatalogEntry | null {
  const enabled = catalog.filter((e) => e.enabled);
  if (serverInstanceID && assistantID) {
    const exact = enabled.find(
      (e) => e.serverInstanceID === serverInstanceID && e.assistantID === assistantID,
    );
    if (exact) return exact;
  }
  return enabled.find((e) => e.isDefaultShareTarget) ?? enabled[0] ?? null;
}

export async function updateShareCatalog(entries: ShareCatalogEntry[]): Promise<void> {
  const { shareNative } = await import('openchamber-system-shell');
  await shareNative.updateCatalog(entries);
}

export async function listPendingShares(): Promise<ShareEnvelope[]> {
  const { shareNative } = await import('openchamber-system-shell');
  const raw = await shareNative.listPending();
  return raw.map(parseShareEnvelope).filter((x): x is ShareEnvelope => !!x);
}

export async function ackShare(operationID: string): Promise<void> {
  const { shareNative } = await import('openchamber-system-shell');
  await shareNative.ack(operationID);
}

export async function releaseShareFiles(operationID: string): Promise<void> {
  const { shareNative } = await import('openchamber-system-shell');
  await shareNative.releaseFiles(operationID);
}
