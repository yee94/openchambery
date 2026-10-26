import React from 'react';
import { loadBrandDisplayFont } from '@/lib/fontLoader';
import { useSidebarBrandStore } from '@/stores/useSidebarBrandStore';
import { cn } from '@/lib/utils';
import { YuriWordmark } from '@/components/ui/YuriWordmark';

/**
 * Left-sidebar wordmark.
 *
 * Placement:
 * - Web: titlebar control row while the sidebar is open
 * - Electron (configured brand): fixed header above the sidebar scroll region,
 *   so the mark does not scroll with sessions
 * - Electron (empty brand): not rendered; no empty slot is reserved
 * - Mobile: leading sidebar content (scrollable)
 *
 * Each standalone Yuri word uses the approved SVG with its 12-unit padding
 * compensated so the visible 256-unit artwork matches the text's cap height.
 * Custom text retains the Syne display face and its original tracking.
 *
 * The configured text is split on whitespace and uses one foreground color. Brand copy is
 * user content, so it is intentionally not localized.
 *
 * An empty (whitespace-only) config hides the mark entirely — no default
 * fallback — so that logo slot stays vacant.
 */
interface SidebarBrandMarkProps {
  className?: string;
}

export const SidebarBrandMark: React.FC<SidebarBrandMarkProps> = ({ className }) => {
  const sidebarBrandName = useSidebarBrandStore((state) => state.sidebarBrandName);
  const brandName = sidebarBrandName.trim();
  const brandWords = brandName.split(/\s+/).filter(Boolean);
  const usesDisplayFont = brandWords.some((word) => word !== 'Yuri');

  React.useEffect(() => {
    if (usesDisplayFont) void loadBrandDisplayFont();
  }, [usesDisplayFont]);

  // Empty config → no custom logo; leave the sidebar brand slot empty.
  if (brandWords.length === 0) {
    return null;
  }

  return (
    <div className={cn('flex min-w-0 items-center overflow-hidden px-2 pb-2 pt-1', className)}>
      <span
        role="img"
        aria-label={brandWords.join(' ')}
        className="inline-flex min-w-0 items-baseline gap-[0.28em] overflow-hidden whitespace-nowrap text-foreground"
        style={{
          fontFamily: '"Syne", var(--font-sans, system-ui, sans-serif)',
          fontSize: '1.0625rem',
          fontWeight: 700,
          letterSpacing: '0.08em',
          lineHeight: 1,
        }}
      >
        {brandWords.map((word, index) => (
          <span
            key={index}
            aria-hidden="true"
            className="inline-flex shrink-0 items-baseline"
          >
            {word === 'Yuri' ? <YuriWordmark width="2.44814cap" className="translate-y-[0.046875cap]" /> : word}
          </span>
        ))}
      </span>
    </div>
  );
};
