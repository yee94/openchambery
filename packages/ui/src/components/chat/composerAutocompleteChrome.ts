import { cn } from '@/lib/utils';

const SURFACE_LAYOUT_DESKTOP =
  'absolute z-[100] min-w-0 w-full bottom-full mb-2 left-0 flex flex-col rounded-xl';
const SURFACE_LAYOUT_MOBILE =
  'pointer-events-auto absolute z-[100] min-w-0 flex flex-col rounded-xl';

export function composerAutocompleteSurfaceClassName(isMobile: boolean, className?: string) {
  return cn(
    isMobile ? SURFACE_LAYOUT_MOBILE : SURFACE_LAYOUT_DESKTOP,
    isMobile
      // Same recipe as the phone context metadata sheet: overlay glass +
      // translucent fill. The catalog is viewport-fixed so iOS can frost the
      // transcript; `absolute` inside the composer cannot.
      ? 'yuri-mobile-overlay-surface yuri-mobile-overlay-surface--translucent yuri-composer-autocomplete-surface'
       : 'yuri-mobile-overlay-surface yuri-mobile-overlay-surface--translucent yuri-composer-autocomplete-surface',
    className,
  );
}

/** Mobile rows skip the persisted selected slab; press fill lives in CSS `:active`. */
export function composerAutocompleteRowClassName(isMobile: boolean, selected: boolean) {
  if (isMobile) return 'yuri-composer-autocomplete-row';
  return cn('mx-1.5 hover:bg-[color-mix(in_srgb,var(--interactive-selection)_40%,transparent)]',
    selected && 'bg-[color-mix(in_srgb,var(--interactive-selection)_40%,transparent)]');
}
