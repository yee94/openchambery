import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type Props = {
  collapseAllProjects: () => void;
  expandAllProjects: () => void;
  /** Button sizing — match nearby sidebar chrome. */
  buttonClassName?: string;
  iconClassName?: string;
};

/**
 * Project collapse/expand menu. Lives in the Projects section header overflow
 * menu so its commands stay grouped with the project tree.
 */
export function SidebarDisplayModeMenu({
  collapseAllProjects,
  expandAllProjects,
  buttonClassName,
  iconClassName,
}: Props): React.ReactNode {
  const { t } = useI18n();

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className={cn(
                'size-6 p-0 text-muted-foreground',
                buttonClassName,
              )}
              aria-label={t('sessions.sidebar.header.actions.sessionDisplayMode')}
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <Icon name="more-2-fill" className={cn('h-3.5 w-3.5', iconClassName)} />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          <p>{t('sessions.sidebar.header.displayMode.label')}</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-[160px]">
        <DropdownMenuItem onClick={collapseAllProjects} className="flex items-center gap-2">
          <Icon name="contract-up-down" className="h-4 w-4" />
          <span>{t('sessions.sidebar.header.displayMode.collapseAll')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={expandAllProjects} className="flex items-center gap-2">
          <Icon name="expand-up-down" className="h-4 w-4" />
          <span>{t('sessions.sidebar.header.displayMode.expandAll')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
