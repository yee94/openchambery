import DOMPurify from 'dompurify';
import { render } from 'pele';
import { DualLimitLru } from '@/lib/dualLimitLru';
import type { Theme } from '@/types/theme';
import type { MermaidRender } from './decorate';

// Streaming decoration reuses completed diagrams without repeating layout.
const cache = new DualLimitLru<string, MermaidRender>({ maxEntries: 100, maxBytes: 8 * 1024 * 1024 });

export const renderMermaidDiagram = (source: string, theme: Theme): MermaidRender => {
  const { surface, interactive, primary, status } = theme.colors;
  const colors: Record<string, string> = {
    bg: surface.elevated,
    fg: surface.foreground,
    muted: surface.mutedForeground,
    line: interactive.border,
    surface: surface.muted,
    'surface-alt': surface.background,
    border: interactive.border,
    accent: primary.base,
    critical: status.error,
    error: status.error,
    'series-1': primary.base,
    'series-2': status.info,
    'series-3': status.success,
    'series-4': status.warning,
    'series-5': status.error,
    'series-6': primary.hover ?? primary.base,
    'series-7': status.infoForeground,
    'series-8': status.successForeground,
  };
  // Gantt today markers must not survive a date change in a long-lived session.
  const key = JSON.stringify([colors, new Date().toDateString(), source]);
  const cached = cache.get(key);
  if (cached) return cached;

  let result: MermaidRender;
  try {
    const { svg } = render(source, {
      fontFamily: 'system-ui, sans-serif',
      autoDirection: false,
      links: false,
      images: false,
    });
    const fragment = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true });
    const element = fragment.querySelector('svg');
    if (!element) throw new Error('Missing diagram SVG');
    // Keep exports self-contained rather than inheriting colors from the page.
    for (const [name, color] of Object.entries(colors)) element.style.setProperty(`--pele-${name}`, color);
    result = { svg: element.outerHTML };
  } catch {
    // Invalid or incomplete streamed syntax remains visible as escaped source.
    result = {};
  }
  cache.set(key, result, (key.length + (result.svg?.length ?? 0)) * 2);
  return result;
};
