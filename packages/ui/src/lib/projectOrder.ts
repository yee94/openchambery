import type { ProjectEntry } from '@/lib/api/types';
import type { DesktopSettings } from '@/lib/desktop';

/** Shared desktop/mobile projection; ties retain authoritative registry order. */
export function sortProjectEntries<T extends ProjectEntry>(projects: T[], mode: DesktopSettings['projectSortOrder']): T[] {
  if (!mode || mode === 'manual') return projects;
  return [...projects].sort((a, b) => {
    switch (mode) {
      case 'a-z':
      case 'z-a': {
        const comparison = (a.label || a.path).toLowerCase().localeCompare((b.label || b.path).toLowerCase(), 'en');
        return mode === 'z-a' ? -comparison : comparison;
      }
      case 'date-added': return (b.addedAt ?? 0) - (a.addedAt ?? 0);
      case 'recent': return (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0);
      default: return 0;
    }
  });
}
