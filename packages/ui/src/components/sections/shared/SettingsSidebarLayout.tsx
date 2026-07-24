import React from 'react';
import { isVSCodeRuntime } from '@/lib/desktop';
import { cn } from '@/lib/utils';

interface SettingsSidebarLayoutProps {
  /** Summary SettingsGroup shown before the collection groups. */
  header?: React.ReactNode;
  /** Footer content (e.g., AboutSettings on mobile) */
  footer?: React.ReactNode;
  /** Collection SettingsGroup elements. */
  children: React.ReactNode;
  /** Additional className for the outer container */
  className?: string;
  /** Background style for the sidebar container */
  variant?: 'sidebar' | 'background';
}

/**
 * Standard layout wrapper for split Settings collection pages.
 * The shared page-content root owns scrolling and responsive padding; callers
 * provide SettingsGroup cards instead of local headers or padded list shells.
 *
 * @example
 * <SettingsSidebarLayout
 *   header={<SettingsSidebarHeader count={items.length} onAdd={handleAdd} />}
 * >
 *   {items.map(item => (
 *     <SettingsSidebarItem key={item.id} ... />
 *   ))}
 * </SettingsSidebarLayout>
 */
export const SettingsSidebarLayout: React.FC<SettingsSidebarLayoutProps> = ({
  header,
  footer,
  children,
  className,
  variant = 'sidebar',
}) => {
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  const bgClass = variant === 'background'
    ? 'bg-background'
    : (isVSCode ? 'bg-background' : 'bg-sidebar');

  return (
    <div
      className={cn(
        'oc-settings-page-content h-full overflow-y-auto p-3',
        bgClass,
        className
      )}
    >
      {header}
      {children}
      {footer}
    </div>
  );
};
