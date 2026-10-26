import type { Theme } from '@/types/theme';
import { presetThemes } from './presets';
import { withPrColors } from './prColors';
import flexokiLightRaw from './flexoki-light.json';
import flexokiDarkRaw from './flexoki-dark.json';
import yuriLightRaw from './fields-of-the-shire-light.json';
import yuriDarkRaw from './fields-of-the-shire-dark.json';

const flexokiLightTheme = withPrColors(flexokiLightRaw as Theme);
const flexokiDarkTheme = withPrColors(flexokiDarkRaw as Theme);
const yuriLightTheme = withPrColors(yuriLightRaw as Theme);
const yuriDarkTheme = withPrColors(yuriDarkRaw as Theme);

export const DEFAULT_LIGHT_THEME_ID = 'carbonfox-light' as const;
export const DEFAULT_DARK_THEME_ID = 'cursor-dark' as const;

export const themes: Theme[] = [
  yuriLightTheme,
  yuriDarkTheme,
  flexokiLightTheme,
  flexokiDarkTheme,
  ...presetThemes.filter(
    (theme) => theme.metadata.id !== 'yuri-light' && theme.metadata.id !== 'yuri-dark',
  ),
];

export function getThemeById(id: string): Theme | undefined {
  // Back-compat for a short-lived rename.
  const resolvedId =
    id === 'app-light' ? 'flexoki-light' :
    id === 'app-dark' ? 'flexoki-dark' :
    id === 'openchamber-light' ? 'yuri-light' :
    id === 'openchamber-dark' ? 'yuri-dark' :
    id;

  return themes.find(theme => theme.metadata.id === resolvedId);
}

export function getDefaultTheme(prefersDark: boolean): Theme {
  const variant: Theme['metadata']['variant'] = prefersDark ? 'dark' : 'light';

  const defaultId = prefersDark ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID;
  const defaultTheme = getThemeById(defaultId);
  if (defaultTheme && defaultTheme.metadata.variant === variant) {
    return defaultTheme;
  }

  return themes.find((theme) => theme.metadata.variant === variant) ?? themes[0] ?? flexokiLightTheme;
}
