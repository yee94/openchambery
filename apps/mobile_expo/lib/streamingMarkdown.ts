/**
 * Streaming markdown helpers for Track 3 Chat.
 * Cap cadence: iOS/web 64ms markdown pace; Android 128ms.
 * Incomplete fences must not throw / corrupt stable content above.
 */

export type StreamingPlatform = 'ios' | 'android' | 'web' | 'default';

export type StreamingRenderCadence = {
  textThrottleMs: number;
  markdownPaceMs: number;
};

const DEFAULT_CADENCE: StreamingRenderCadence = {
  textThrottleMs: 20,
  markdownPaceMs: 64,
};

const ANDROID_CADENCE: StreamingRenderCadence = {
  textThrottleMs: 100,
  markdownPaceMs: 128,
};

export const resolveStreamingRenderCadence = (
  platform: StreamingPlatform = 'default',
): StreamingRenderCadence =>
  platform === 'android' ? ANDROID_CADENCE : DEFAULT_CADENCE;

/** True when a fenced code block is opened but not closed. */
export const hasOpenFence = (raw: string): boolean => {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return false;
  const mark = match[1];
  if (!mark) return false;
  const char = mark[0];
  const size = mark.length;
  const last = raw.trimEnd().split('\n').at(-1)?.trim() ?? '';
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last);
};

/**
 * Count unpaired fence openers in full message text (``` or ~~~).
 * Safe for streaming — never throws.
 */
export const countOpenFences = (text: string): number => {
  try {
    const lines = text.split('\n');
    let open = 0;
    let active: { char: string; size: number } | null = null;
    for (const line of lines) {
      const m = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
      if (!m || !m[1]) continue;
      const mark = m[1];
      const char = mark[0]!;
      const size = mark.length;
      if (!active) {
        active = { char, size };
        open += 1;
        continue;
      }
      if (char === active.char && size >= active.size && !(m[2] ?? '').trim()) {
        active = null;
        open = Math.max(0, open - 1);
      }
    }
    return open;
  } catch {
    return 0;
  }
};

export type MarkdownSegment = {
  raw: string;
  /** When true, treat as live open fence — do not hard-fail parse. */
  openFence: boolean;
  live: boolean;
};

/**
 * Isolate a trailing incomplete fence so it cannot corrupt stable content.
 * Always returns at least one segment; never throws.
 */
export const segmentStreamingMarkdown = (
  text: string,
  live: boolean,
): MarkdownSegment[] => {
  try {
    if (!text) return [{ raw: '', openFence: false, live }];
    if (!live) {
      return [{ raw: text, openFence: hasOpenFence(text), live: false }];
    }

    // Find last fence opener that is still open.
    const lines = text.split('\n');
    let fenceStart = -1;
    let active: { char: string; size: number; start: number } | null = null;
    let offset = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const m = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
      if (m?.[1]) {
        const mark = m[1];
        const char = mark[0]!;
        const size = mark.length;
        if (!active) {
          active = { char, size, start: offset };
          fenceStart = offset;
        } else if (char === active.char && size >= active.size && !(m[2] ?? '').trim()) {
          active = null;
          fenceStart = -1;
        }
      }
      offset += line.length + (i < lines.length - 1 ? 1 : 0);
    }

    if (fenceStart < 0 || !active) {
      return [{ raw: text, openFence: false, live: true }];
    }

    const stable = text.slice(0, fenceStart);
    const fence = text.slice(fenceStart);
    const segments: MarkdownSegment[] = [];
    if (stable.length > 0) {
      segments.push({ raw: stable, openFence: false, live: false });
    }
    segments.push({ raw: fence, openFence: true, live: true });
    return segments;
  } catch {
    return [{ raw: text, openFence: false, live }];
  }
};

/**
 * Safe display text for streaming markdown. Open fences render as plain pre
 * body without closing the fence (avoids throw / whole-message blink).
 */
export const safeStreamingMarkdownText = (text: string, live: boolean): string => {
  try {
    const segments = segmentStreamingMarkdown(text, live);
    return segments
      .map((seg) => {
        if (!seg.openFence) return seg.raw;
        // Strip the opening fence marker for plain display of incomplete code.
        const stripped = seg.raw.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n?/, '');
        return stripped.length > 0 ? stripped : seg.raw;
      })
      .join('');
  } catch {
    return text;
  }
};

/**
 * Pace helper: only publish markdown render when cadence elapsed.
 * Text can update more often; markdown parse stays at markdownPaceMs.
 */
export class StreamingMarkdownPacer {
  private lastPublishAt = 0;
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly paceMs: number;
  private readonly onPublish: (text: string) => void;

  constructor(paceMs: number, onPublish: (text: string) => void) {
    this.paceMs = Math.max(0, paceMs);
    this.onPublish = onPublish;
  }

  push(text: string, force = false): void {
    const now = Date.now();
    if (force || this.paceMs === 0 || now - this.lastPublishAt >= this.paceMs) {
      this.clearTimer();
      this.pending = null;
      this.lastPublishAt = now;
      this.onPublish(text);
      return;
    }
    this.pending = text;
    if (this.timer != null) return;
    const wait = this.paceMs - (now - this.lastPublishAt);
    this.timer = setTimeout(() => {
      this.timer = null;
      const next = this.pending;
      this.pending = null;
      if (next != null) {
        this.lastPublishAt = Date.now();
        this.onPublish(next);
      }
    }, Math.max(0, wait));
  }

  flush(): void {
    if (this.pending != null) {
      const next = this.pending;
      this.clearTimer();
      this.pending = null;
      this.lastPublishAt = Date.now();
      this.onPublish(next);
    }
  }

  dispose(): void {
    this.clearTimer();
    this.pending = null;
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
