import React from 'react';
import {
  buildSkillRows,
  emitComposerAutocompleteRows,
  rankSkillsForQuery,
  resetComposerAutocompleteRows,
  type ComposerAutocompleteVisibleRows,
} from '@/lib/composer-autocomplete';
import { cn } from '@/lib/utils';
import { useInstalledSkillsQuery } from '@/queries/installedSkillsQueries';
import { useUIStore } from '@/stores/useUIStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';
import {
  composerAutocompleteRowClassName,
  composerAutocompleteSurfaceClassName,
} from './composerAutocompleteChrome';

export interface SkillInfo {
  name: string;
  scope: string;
  source?: string;
  description?: string;
}

export interface SkillAutocompleteHandle {
  handleKeyDown: (key: string) => void;
  acceptIndex: (index: number) => void;
}

interface SkillAutocompleteProps {
  searchQuery: string;
  onSkillSelect: (skill: SkillInfo) => void;
  onClose: () => void;
  directory?: string | null;
  style?: React.CSSProperties;
  onRowsChange?: (rows: ComposerAutocompleteVisibleRows) => void;
}

export const SkillAutocomplete = React.forwardRef<SkillAutocompleteHandle, SkillAutocompleteProps>(({
  searchQuery,
  onSkillSelect,
  onClose,
  directory,
  style,
  onRowsChange,
}, ref) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const isMobile = useUIStore((state) => state.isMobile);
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(containerRef, isMobile);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const selectedIndexRef = React.useRef(0);
  const keyboardNavigationRef = React.useRef(false);
  const [filteredSkills, setFilteredSkills] = React.useState<SkillInfo[]>([]);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const lastVisibleRowsRef = React.useRef<ComposerAutocompleteVisibleRows | null>(null);
  const skillsQuery = useInstalledSkillsQuery({ directory });
  const skills = React.useMemo(() => skillsQuery.data ?? [], [skillsQuery.data]);

  React.useEffect(() => {
    setFilteredSkills(rankSkillsForQuery(skills, searchQuery));
    setSelectedIndex(0);
  }, [skills, searchQuery]);

  React.useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  React.useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({
      block: 'nearest',
    });
  }, [selectedIndex]);

  React.useEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target || !containerRef.current) {
        return;
      }
      if (!containerRef.current.contains(target)) {
        onClose();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [onClose]);

  React.useEffect(() => {
    emitComposerAutocompleteRows(onRowsChange, lastVisibleRowsRef, {
      rows: buildSkillRows(filteredSkills),
      highlightedIndex: selectedIndex,
    });
  }, [filteredSkills, onRowsChange, selectedIndex]);

  const onRowsChangeRef = React.useRef(onRowsChange);
  onRowsChangeRef.current = onRowsChange;
  React.useEffect(() => () => {
    resetComposerAutocompleteRows(onRowsChangeRef.current, lastVisibleRowsRef);
  }, []);

  React.useImperativeHandle(ref, () => ({
    acceptIndex: (index: number) => {
      const skill = filteredSkills[index];
      if (skill) onSkillSelect(skill);
    },
    handleKeyDown: (key: string) => {
      if (key === 'Escape') {
        onClose();
        return;
      }

      if (!filteredSkills.length) {
        return;
      }

      if (key === 'ArrowDown') {
        keyboardNavigationRef.current = true;
        setSelectedIndex((prev) => (prev + 1) % filteredSkills.length);
        return;
      }

      if (key === 'ArrowUp') {
        keyboardNavigationRef.current = true;
        setSelectedIndex((prev) => (prev - 1 + filteredSkills.length) % filteredSkills.length);
        return;
      }

      if (key === 'Enter' || key === 'Tab') {
        const safeIndex = ((selectedIndexRef.current % filteredSkills.length) + filteredSkills.length) % filteredSkills.length;
        const skill = filteredSkills[safeIndex];
        if (skill) {
          onSkillSelect(skill);
        }
      }
    },
  }), [filteredSkills, onSkillSelect, onClose]);

  const renderSkill = (skill: SkillInfo, index: number) => {
    const isProject = skill.scope === 'project';
    const source = skill.source || 'opencode';
    return (
      <div
        key={`${skill.name}-${skill.scope}`}
        ref={(el) => {
          itemRefs.current[index] = el;
        }}
          className={cn(
            'flex gap-2 px-3 py-1.5 cursor-pointer rounded-lg typography-ui-label',
            isMobile ? 'items-center' : 'items-start',
            composerAutocompleteRowClassName(isMobile, index === selectedIndex),
        )}
        onClick={() => onSkillSelect(skill)}
        onMouseMove={() => {
          keyboardNavigationRef.current = false;
          setSelectedIndex(index);
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold truncate">{skill.name}</span>
            <span className={cn(
              "text-[10px] leading-none uppercase font-bold tracking-tight px-1.5 py-1 rounded border flex-shrink-0 transition-colors",
              isProject 
                ? "bg-[var(--status-info-background)] text-[var(--status-info)] border-[var(--status-info-border)]"
                : "bg-[var(--status-success-background)] text-[var(--status-success)] border-[var(--status-success-border)]"
            )}>
              {skill.scope}
            </span>
            <span className="text-[10px] leading-none uppercase font-bold tracking-tight px-1.5 py-1 rounded border flex-shrink-0 bg-[var(--surface-muted)] text-muted-foreground border-[var(--interactive-border)]/60">
              {source}
            </span>
          </div>
          {skill.description && !isMobile && (
            <div className="typography-meta text-muted-foreground mt-0.5 truncate">
              {skill.description}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className={composerAutocompleteSurfaceClassName(isMobile, 'max-w-[450px] max-h-60')}
      style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}
    >
      <ScrollableOverlay preventOverscroll outerClassName="flex-1 min-h-0" className="px-0 pb-2">
        {filteredSkills.length ? (
          <div>
            {filteredSkills.map((skill, index) => renderSkill(skill, index))}
          </div>
        ) : (
          <div className="px-3 py-2 typography-ui-label text-muted-foreground">
            No skills found
          </div>
        )}
      </ScrollableOverlay>
      {!isMobile && (
        <div className="px-3 pt-1 pb-1.5 border-t typography-meta text-muted-foreground">
          ↑↓ navigate • Enter select • Esc close
        </div>
      )}
    </div>
  );
});

SkillAutocomplete.displayName = 'SkillAutocomplete';
