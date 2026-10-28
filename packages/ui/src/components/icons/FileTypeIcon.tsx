import React from 'react';
import { cn } from '@/lib/utils';
import { getFileTypeIconHref } from '@/lib/fileTypeIcons';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { GuiFileIconsContext } from '@/lib/gui-plugins/react';

const emptyIcon = () => undefined;
const noSubscription = () => () => {};

type FileTypeIconProps = {
  filePath: string;
  extension?: string;
  /** OpenCode directory attachments (`application/x-directory`) use the folder glyph. */
  isDirectory?: boolean;
  className?: string;
};

export const FileTypeIcon: React.FC<FileTypeIconProps> = ({ filePath, extension, isDirectory, className }) => {
  const theme = useOptionalThemeSystem();
  const variant = theme?.currentTheme.metadata.variant === 'light' ? 'light' : 'dark';
  const icons = React.useContext(GuiFileIconsContext);
  const subscribe = React.useMemo(() => icons ? (listener: () => void) => icons.subscribe(listener) : noSubscription, [icons]);
  const readIcon = React.useMemo(() => icons
    ? () => icons.get(filePath, { extension, isDirectory, themeVariant: variant })
    : emptyIcon, [icons, filePath, extension, isDirectory, variant]);
  const customIcon = React.useSyncExternalStore(subscribe, readIcon, emptyIcon);
  const [failedIcon, setFailedIcon] = React.useState<string>();
  if (customIcon && customIcon !== failedIcon) {
    return <img
      src={customIcon}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn('block h-4 w-4 flex-shrink-0', className)}
      onError={() => setFailedIcon(customIcon)}
    />;
  }
  const iconHref = getFileTypeIconHref(filePath, { extension, isDirectory, themeVariant: variant });

  return (
    <svg
      className={cn('block h-4 w-4 flex-shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      <use href={iconHref} xlinkHref={iconHref} />
    </svg>
  );
};
