import type { IconName } from '@/components/icon/icons';

export type ComposerAutocompleteKind = 'slash-command' | 'mention';

export type ComposerAutocompleteTrigger = {
  kind: ComposerAutocompleteKind;
  query: string;
  tokenStart: number;
  tokenEnd: number;
};

export type ComposerAutocompleteInputMode = 'normal' | 'shell' | (string & {});

export type ComposerAutocompleteMentionSource = 'manual' | 'paste';

export type ComposerAutocompleteListRow = {
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  iconName: IconName;
  agentName?: string;
};

export type ComposerAutocompleteVisibleRows = {
  rows: readonly ComposerAutocompleteListRow[];
  highlightedIndex: number;
};
