import React from 'react';
import { cn } from '@/lib/utils';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';

export const PROJECT_SETTINGS_CONTROL_WIDTH = 'w-full max-w-[30rem]';

type ProjectSettingsSubsectionProps = {
  title: string;
  description?: string;
  settingsItem?: string;
  titleAccessory?: React.ReactNode;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
};

export const ProjectSettingsSubsection: React.FC<ProjectSettingsSubsectionProps> = ({
  title,
  description,
  settingsItem,
  titleAccessory,
  headerAction,
  children,
  className,
  contentClassName,
}) => {
  return (
    <div
      data-settings-item={settingsItem}
      className={className}
    >
      <SettingsGroup
        className="oc-settings-detail-group"
        label={(
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate">{title}</span>
              {titleAccessory}
            </div>
            {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
          </div>
        )}
        description={description}
      >
        <div className={cn('oc-settings-group-row', contentClassName)}>{children}</div>
      </SettingsGroup>
    </div>
  );
};
