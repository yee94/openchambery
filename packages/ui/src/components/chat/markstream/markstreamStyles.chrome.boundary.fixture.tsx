import React from 'react';
import { getDefaultTheme } from '@/lib/theme/themes';

// Only application context boundaries are replaced; both markdown engines,
// decoration, highlighting, and their styles run from production modules.
export const FixtureThemeContext = React.createContext(getDefaultTheme(false));
export const useOptionalThemeSystem = () => ({ currentTheme: React.useContext(FixtureThemeContext) });
export const useEffectiveDirectory = () => '/example/project';
export const useRuntimeAPIs = () => ({ editor: undefined, runtime: { isVSCode: false } });
