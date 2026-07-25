import React from 'react';
import { useDeviceInfo } from '@/lib/device';
import { usesMobileTypographyBase } from '@/lib/typography';
import { useUIStore } from '@/stores/useUIStore';

interface ThemeProviderProps {
  children: React.ReactNode;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  const fontSize = useUIStore((state) => state.fontSize);
  const codeFontSize = useUIStore((state) => state.codeFontSize);
  const applyTypography = useUIStore((state) => state.applyTypography);
  const padding = useUIStore((state) => state.padding);
  const applyPadding = useUIStore((state) => state.applyPadding);
  // Re-apply when device classes change (mobile vs desktop typography bases).
  const { deviceType, hasTouchInput } = useDeviceInfo();
  const mobileTypography = typeof document !== 'undefined' && usesMobileTypographyBase();

  React.useLayoutEffect(() => {
    applyTypography();
    applyPadding();
  }, [
    fontSize,
    codeFontSize,
    applyTypography,
    padding,
    applyPadding,
    deviceType,
    hasTouchInput,
    mobileTypography,
  ]);

  return <>{children}</>;
};
