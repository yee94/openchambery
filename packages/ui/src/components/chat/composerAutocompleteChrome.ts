import { cn } from '@/lib/utils';

const SURFACE_LAYOUT =
  'absolute z-[100] min-w-0 w-full bottom-full mb-2 left-0 flex flex-col rounded-xl';

export function composerAutocompleteSurfaceClassName(isMobile: boolean, className?: string) {
  return cn(
    SURFACE_LAYOUT,
    isMobile
      ? 'oc-composer-autocomplete-surface'
      : 'bg-background border-2 border-border/60 shadow-none',
    className,
  );
}

/** Mobile rows skip the persisted selected slab; press fill lives in CSS `:active`. */
export function composerAutocompleteRowClassName(isMobile: boolean, selected: boolean) {
  if (isMobile) return 'oc-composer-autocomplete-row';
  return selected ? 'bg-interactive-selection' : undefined;
}
