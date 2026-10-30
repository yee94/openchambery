import React from 'react';
import { getAgentColor } from '@/lib/agentColors';
import { generatedAvatarDataUri, type AvatarKind } from '@/lib/generatedAvatar';
import { useAgentAvatarPalette } from '@/lib/useAgentAvatarPalette';
import { cn } from '@/lib/utils';
import { ProceduralAssistantAvatar } from '@/components/assistants/ProceduralAssistantAvatar';
import type { AvatarMotion } from '@/lib/assistant-avatar/recipe';

type AgentAvatarProps = {
  /** Agent name seed — drives both pattern and theme color. */
  name: string | undefined;
  kind?: AvatarKind;
  animated?: boolean;
  motion?: AvatarMotion;
  /** Optional glyph used in place of the generated identicon. */
  emoji?: string;
  size?: number;
  /**
   * `rounded` keeps the compact agent-badge chip; `circle` is the Assistant
   * contact face (list / header / settings) so emoji and identicon match.
   */
  shape?: 'rounded' | 'circle' | 'square';
  className?: string;
  /** Accessible name when the surrounding control no longer shows text. */
  label?: string;
};

/**
 * Deterministic local DiceBear avatar; explicit emoji remains a custom override.
 * Agents paint their own computed accent color; the plate always carries that
 * accent so its face never drifts from the matching agent badge.
 */
const DiceBearAvatar: React.FC<AgentAvatarProps> = React.memo(({
  name,
  kind = 'agent',
  animated = false,
  emoji,
  size = 16,
  shape = 'rounded',
  className,
  label,
}) => {
  const color = getAgentColor(name);
  const palette = useAgentAvatarPalette(name);
  const avatar = React.useMemo(() => {
    if (emoji) return undefined;
    if (kind !== 'agent') return generatedAvatarDataUri(kind, name, animated);
    // Every Agent owns one computed accent token; its plate reuses that exact
    // color so the face never drifts from the matching agent badge.
    return generatedAvatarDataUri(kind, name, animated, palette);
  }, [palette, emoji, kind, name, animated]);

  return (
    <span
      className={cn(
        'inline-flex aspect-square shrink-0 overflow-clip',
        shape === 'square' ? 'rounded-none' : shape === 'circle' ? 'rounded-full' : 'rounded-sm',
        emoji && 'items-center justify-center select-none',
        color.class,
        className,
      )}
      // Emoji uses inline display+align so a caller className like `block`
      // cannot strip the flex box and leave the glyph off-center.
      style={{
        width: `calc(${size}px * var(--dpt-n, 1))`,
        minWidth: `calc(${size}px * var(--dpt-n, 1))`,
        maxWidth: `calc(${size}px * var(--dpt-n, 1))`,
        height: `calc(${size}px * var(--dpt-n, 1))`,
        minHeight: `calc(${size}px * var(--dpt-n, 1))`,
        maxHeight: `calc(${size}px * var(--dpt-n, 1))`,
        color: `var(${color.var})`,
        ...(emoji
          ? {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }
          : null),
      }}
      data-agent-avatar=""
      data-avatar-kind={kind}
      data-agent-avatar-shape={shape}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {emoji ? (
        <span
          aria-hidden="true"
          className="flex h-full w-full items-center justify-center leading-none"
          style={{
            fontSize: `calc(${size * 0.75}px * var(--dpt-n, 1))`,
            lineHeight: 1,
            // Emoji fonts paint slightly high in the em box on iOS/Android.
            transform: 'translateY(0.06em)',
          }}
        >
          {emoji}
        </span>
      ) : <img src={avatar} alt="" draggable={false} className="block h-full w-full max-h-full max-w-full object-contain" aria-hidden="true" />}
    </span>
  );
});

export const AgentAvatar: React.FC<AgentAvatarProps> = React.memo(function AgentAvatar(props) {
  if (props.kind === 'assistant' && !props.emoji) {
    return <ProceduralAssistantAvatar seed={props.name} size={props.size ?? 16} label={props.label} className={props.className} motion={props.motion ?? (props.animated ? 'thinking' : undefined)} />;
  }
  return <DiceBearAvatar {...props} />;
});
