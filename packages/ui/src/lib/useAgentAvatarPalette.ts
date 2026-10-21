import { useMemo } from 'react';

import { getAgentColor } from '@/lib/agentColors';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { resolveAgentAvatarColors, type AvatarColorSet } from '@/lib/generatedAvatar';

/**
 * Each Agent owns a computed accent token (see `getAgentColor`). This resolves
 * that token to a background color for its generated artwork, so
 * an Agent's avatar plate always matches its own badge color.
 */
export const useAgentAvatarPalette = (agentName: string | undefined): AvatarColorSet => {
  const accentVar = getAgentColor(agentName).var;
  const colors = useOptionalThemeSystem()?.currentTheme.colors;
  return useMemo(() => {
    const tokens: Record<string, string> = colors ? {
      '--status-success': colors.status.success,
      '--status-info': colors.status.info,
      '--status-warning': colors.status.warning,
      '--syntax-keyword': colors.syntax.base.keyword,
      '--syntax-type': colors.syntax.base.type,
      '--syntax-function': colors.syntax.base.function,
      '--syntax-number': colors.syntax.base.number,
      '--syntax-variable': colors.syntax.base.variable,
    } : {};
    return resolveAgentAvatarColors(accentVar, (token) => tokens[token] ?? '');
  }, [accentVar, colors]);
};
