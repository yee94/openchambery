export type ComposerAutocompleteKind = 'slash-command' | 'slash-skill' | 'mention' | 'snippet';

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
  iconName: string;
};

export type ComposerAutocompleteVisibleRows = {
  rows: readonly ComposerAutocompleteListRow[];
  highlightedIndex: number;
};
