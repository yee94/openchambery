/**
 * Cap/OpenCode message part projection for Lynx turn cards.
 * Only real Cap part types — never invent Lynx-only kinds.
 *
 * Cap sources: message parts (text / reasoning / tool / file / agent),
 * ProgressiveGroup collapsed Activity, QuestionCard, PermissionCard.
 */

export const LYNX_KNOWN_PART_TYPES = [
  'text',
  'reasoning',
  'tool',
  'file',
  'agent',
  'step-start',
  'step-finish',
  'snapshot',
  'patch',
  'retry',
] as const;

export type LynxKnownPartType = typeof LYNX_KNOWN_PART_TYPES[number];

export type LynxToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'unknown';

export type LynxMessagePart =
  | { type: 'text'; id: string; text: string }
  | { type: 'reasoning'; id: string; text: string }
  | {
    type: 'tool';
    id: string;
    tool: string;
    status: LynxToolStatus;
    title?: string;
    inputSummary?: string;
  }
  | { type: 'file'; id: string; mime: string; filename?: string; url?: string }
  | { type: 'agent'; id: string; name?: string }
  | { type: 'other'; id: string; rawType: string };

export type LynxActivityRow = {
  id: string;
  kind: 'tool' | 'reasoning';
  label: string;
  status?: LynxToolStatus;
};

export type LynxActivityProjection = {
  /** Collapsed Activity header label spirit (Working / Processed / tools count). */
  headerLabel: string;
  toolCount: number;
  reasoningCount: number;
  running: boolean;
  /** Detail rows shown only when expanded. */
  rows: LynxActivityRow[];
};

export type LynxTurnCardModel = {
  messageId: string;
  role: 'user' | 'assistant' | 'system' | 'unknown';
  /** Plain text fallback (user bubbles / assistant final text). */
  text: string;
  parts: LynxMessagePart[];
  /** Assistant Activity disclosure when tools/reasoning exist. */
  activity: LynxActivityProjection | null;
  /** Visible assistant body text outside Activity. */
  bodyText: string;
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const toolStatusOf = (state: unknown): LynxToolStatus => {
  const status = asRecord(state).status;
  if (status === 'pending' || status === 'running' || status === 'completed' || status === 'error') {
    return status;
  }
  return 'unknown';
};

const partId = (raw: Record<string, unknown>, index: number, fallbackPrefix: string): string => {
  if (typeof raw.id === 'string' && raw.id.trim()) return raw.id.trim();
  return `${fallbackPrefix}_${index}`;
};

/** Parse one Cap/OpenCode part. Unknown types become `other` (still not invented). */
export function parseLynxMessagePart(raw: unknown, index: number): LynxMessagePart | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = asRecord(raw);
  const type = typeof record.type === 'string' ? record.type : '';
  if (!type) return null;

  if (type === 'text') {
    const text = typeof record.text === 'string' ? record.text : '';
    return { type: 'text', id: partId(record, index, 'text'), text };
  }
  if (type === 'reasoning') {
    const text = typeof record.text === 'string' ? record.text : '';
    if (!text.trim()) return null;
    return { type: 'reasoning', id: partId(record, index, 'reasoning'), text };
  }
  if (type === 'tool') {
    const tool = typeof record.tool === 'string' && record.tool.trim()
      ? record.tool.trim()
      : 'tool';
    const state = record.state;
    const title = typeof asRecord(state).title === 'string'
      ? (asRecord(state).title as string)
      : undefined;
    let inputSummary: string | undefined;
    const input = asRecord(state).input ?? record.input;
    if (input && typeof input === 'object') {
      try {
        inputSummary = JSON.stringify(input).slice(0, 120);
      } catch {
        inputSummary = undefined;
      }
    }
    return {
      type: 'tool',
      id: partId(record, index, 'tool'),
      tool,
      status: toolStatusOf(state),
      title,
      inputSummary,
    };
  }
  if (type === 'file') {
    const mime = typeof record.mime === 'string' ? record.mime : 'application/octet-stream';
    const filename = typeof record.filename === 'string'
      ? record.filename
      : typeof record.name === 'string'
        ? record.name
        : undefined;
    const url = typeof record.url === 'string' ? record.url : undefined;
    return { type: 'file', id: partId(record, index, 'file'), mime, filename, url };
  }
  if (type === 'agent') {
    const name = typeof record.name === 'string'
      ? record.name
      : typeof record.agent === 'string'
        ? record.agent
        : undefined;
    return { type: 'agent', id: partId(record, index, 'agent'), name };
  }

  // Cap also emits step-start / step-finish / snapshot / patch / retry — keep as other.
  return { type: 'other', id: partId(record, index, type), rawType: type };
}

export function parseLynxMessageParts(parts: unknown): LynxMessagePart[] {
  if (!Array.isArray(parts)) return [];
  return parts
    .map((part, index) => parseLynxMessagePart(part, index))
    .filter((part): part is LynxMessagePart => part !== null);
}

export function textFromLynxParts(parts: readonly LynxMessagePart[]): string {
  return parts
    .filter((part): part is Extract<LynxMessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/**
 * Cap ProgressiveGroup spirit: tools + reasoning fold under one Activity disclosure.
 * Collapsed = header only; expanded rows are the ordered tool/reasoning timeline.
 */
export function projectLynxActivity(
  parts: readonly LynxMessagePart[],
  options?: { expanded?: boolean },
): LynxActivityProjection | null {
  const tools = parts.filter((part): part is Extract<LynxMessagePart, { type: 'tool' }> => part.type === 'tool');
  const reasoning = parts.filter((part): part is Extract<LynxMessagePart, { type: 'reasoning' }> => part.type === 'reasoning');
  if (tools.length === 0 && reasoning.length === 0) return null;

  const running = tools.some((tool) => tool.status === 'running' || tool.status === 'pending');
  const headerLabel = running
    ? (tools.length > 0 ? `Working · ${tools.length} tool${tools.length === 1 ? '' : 's'}` : 'Working')
    : (tools.length > 0
      ? `Processed · ${tools.length} tool${tools.length === 1 ? '' : 's'}`
      : 'Thought');

  const rows: LynxActivityRow[] = [];
  // Cap collapsedPreviewCount = 0: collapsed hides all detail rows.
  if (options?.expanded === true) {
    for (const part of parts) {
      if (part.type === 'tool') {
        rows.push({
          id: part.id,
          kind: 'tool',
          label: part.title?.trim() || part.tool,
          status: part.status,
        });
      } else if (part.type === 'reasoning') {
        rows.push({
          id: part.id,
          kind: 'reasoning',
          label: part.text.trim().slice(0, 160) || 'Reasoning',
        });
      }
    }
  }

  return {
    headerLabel,
    toolCount: tools.length,
    reasoningCount: reasoning.length,
    running,
    rows,
  };
}

/**
 * Build a turn card from Cap message parts.
 * User: text (+ file chips). Assistant: Activity disclosure + remaining body text.
 */
export function buildLynxTurnCard(input: {
  messageId: string;
  role: 'user' | 'assistant' | 'system' | 'unknown';
  parts: readonly LynxMessagePart[];
  activityExpanded?: boolean;
}): LynxTurnCardModel {
  const text = textFromLynxParts(input.parts);
  const activity = input.role === 'assistant'
    ? projectLynxActivity(input.parts, { expanded: input.activityExpanded === true })
    : null;

  return {
    messageId: input.messageId,
    role: input.role,
    text,
    parts: [...input.parts],
    activity,
    bodyText: text,
  };
}

/** Cap QuestionRequest shape (types/question.ts) — pending list, not a message part. */
export type LynxQuestionRequest = {
  id: string;
  sessionID: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
  }>;
};

/** Cap PermissionRequest shape (types/permission.ts). */
export type LynxPermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  always: string[];
};

export function parseLynxQuestionRequest(raw: unknown): LynxQuestionRequest | null {
  const record = asRecord(raw);
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const sessionID = typeof record.sessionID === 'string' ? record.sessionID.trim() : '';
  if (!id || !sessionID) return null;
  if (!Array.isArray(record.questions)) return null;
  const questions = record.questions.map((item) => {
    const q = asRecord(item);
    const options = Array.isArray(q.options)
      ? q.options.map((opt) => {
        const o = asRecord(opt);
        return {
          label: typeof o.label === 'string' ? o.label : '',
          description: typeof o.description === 'string' ? o.description : '',
        };
      })
      : [];
    return {
      question: typeof q.question === 'string' ? q.question : '',
      header: typeof q.header === 'string' ? q.header : '',
      options,
      multiple: q.multiple === true,
    };
  });
  return { id, sessionID, questions };
}

export function parseLynxPermissionRequest(raw: unknown): LynxPermissionRequest | null {
  const record = asRecord(raw);
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const sessionID = typeof record.sessionID === 'string' ? record.sessionID.trim() : '';
  const permission = typeof record.permission === 'string' ? record.permission : '';
  if (!id || !sessionID || !permission) return null;
  const patterns = Array.isArray(record.patterns)
    ? record.patterns.filter((p): p is string => typeof p === 'string')
    : [];
  const always = Array.isArray(record.always)
    ? record.always.filter((p): p is string => typeof p === 'string')
    : [];
  return { id, sessionID, permission, patterns, always };
}
