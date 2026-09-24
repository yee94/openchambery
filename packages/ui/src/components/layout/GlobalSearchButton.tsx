import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

interface GlobalSearchButtonProps {
  className?: string;
  mobile?: boolean;
}

export const GlobalSearchButton: React.FC<GlobalSearchButtonProps> = ({ className, mobile = false }) => {
  const { t } = useI18n();
  const setCommandPaletteOpen = useUIStore((state) => state.setCommandPaletteOpen);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const searchShortcut = formatShortcutForDisplay(
    getEffectiveShortcutCombo('open_command_palette', shortcutOverrides),
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={mobile ? 'mobileGlass' : 'ghost'}
          size={mobile ? 'mobileIcon' : 'icon'}
          onClick={() => setCommandPaletteOpen(true)}
          aria-label={t('commandPalette.title')}
          className={cn(
            'app-region-no-drag',
            !mobile && 'size-7 rounded-md text-muted-foreground/75 focus-visible:ring-2 focus-visible:ring-primary',
            className,
          )}
        >
          <Icon
            name="search"
            className="size-4 text-foreground/55 transition-colors group-hover:text-foreground group-focus-visible:text-foreground"
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p className="flex items-center gap-2">
          <span>{t('commandPalette.title')}</span>
          {!mobile ? <span className="text-muted-foreground">{searchShortcut}</span> : null}
        </p>
      </TooltipContent>
    </Tooltip>
  );
};
