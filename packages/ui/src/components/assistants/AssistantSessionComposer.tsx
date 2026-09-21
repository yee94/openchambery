import React from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import { useQuery } from '@tanstack/react-query';
import { decorateComposerReference, expandComposerReferenceSelection, insertComposerReference, materializeSessionMentionTokens, reconcileComposerDocument, resolveComposerReferenceDeletion, serializeComposerDocument, type ComposerDocument } from '@/composer/document';
import { createComposerReferenceHistorySnapshot, emptyComposerReferenceHistory, pushComposerReferenceHistory, redoComposerReferenceHistory, undoComposerReferenceHistory } from '@/composer/reference-history';
import { composerTriggerIconDisplay } from '@/composer/inline-visual';
import { ComposerTriggerIconMark } from '@/components/chat/ComposerTriggerIconMark';
import { buildHighlightParts } from '@/components/chat/composerHighlight';
import { ChatPromptComposer } from '@/components/chat/ChatPromptComposer';
import { ComposerAutocompleteLayer } from '@/components/chat/ComposerAutocompleteLayer';
import { composerAutocompleteRowClassName } from '@/components/chat/composerAutocompleteChrome';
import { createMentionTouchSelectionController } from '@/components/chat/fileMentionTouchSelection';
import { getVisibleSessionMentionCandidates } from '@/components/chat/fileMentionAutocompleteState';
import { useRuntimeTransportIdentity } from '@/components/chat/imageSource';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { resolveComposerAutocompleteTrigger } from '@/lib/composer-autocomplete';
import { isIMECompositionEvent } from '@/lib/ime';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SessionIndexSnapshot } from '@/lib/session-index-api';
import { sessionIndexSnapshotQueryOptions } from '@/queries/sessionIndexQueries';

const selectSessions = (snapshot: SessionIndexSnapshot | null) => snapshot?.directories.flatMap(({ directory, sessions }) => (
  directory ? sessions.filter((session) => !session.time.archived).map((session) => ({ ...session, directory })) : []
)) ?? null;
type MentionSession = NonNullable<ReturnType<typeof selectSessions>>[number];
type PickerHandle = { keyDown: (key: string) => void };

const SessionMentionPicker = React.forwardRef<PickerHandle, {
  query: string;
  isMobile: boolean;
  listId: string;
  onHighlightChange: (id: string | undefined) => void;
  onSelect: (session: MentionSession) => void;
  onClose: () => void;
}>(({ query, isMobile, listId, onHighlightChange, onSelect, onClose }, ref) => {
  const { t } = useI18n();
  const transport = useRuntimeTransportIdentity();
  const result = useQuery({ ...sessionIndexSnapshotQueryOptions(transport), select: selectSessions });
  const sessions = React.useMemo(() => getVisibleSessionMentionCandidates({
    sessions: result.data ?? [], currentSessionId: null, searchQuery: query,
  }), [result.data, query]);
  const [highlight, setHighlight] = React.useState({ query, index: 0 });
  const index = Math.min(highlight.query === query ? highlight.index : 0, Math.max(0, sessions.length - 1));
  const containerRef = React.useRef<HTMLDivElement>(null);
  const rowRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const touch = React.useMemo(createMentionTouchSelectionController, []);
  useEventListener('pointerdown', (event: PointerEvent) => {
    if (event.target instanceof Node && !containerRef.current?.contains(event.target)) onClose();
  }, undefined, { capture: true });
  React.useLayoutEffect(() => { rowRefs.current[index]?.scrollIntoView?.({ block: 'nearest' }); }, [index]);
  React.useLayoutEffect(() => {
    onHighlightChange(sessions.length ? `${listId}-${index}` : undefined);
  }, [index, listId, sessions.length, onHighlightChange]);
  const keyDown = useEvent((key: string) => {
    if (key === 'Escape') { onClose(); return; }
    if (!sessions.length) return;
    if (key === 'ArrowDown') setHighlight({ query, index: (index + 1) % sessions.length });
    if (key === 'ArrowUp') setHighlight({ query, index: (index - 1 + sessions.length) % sessions.length });
    if (key === 'Enter' || key === 'Tab') onSelect(sessions[index]);
  });
  React.useImperativeHandle(ref, () => ({ keyDown }), [keyDown]);
  return <ComposerAutocompleteLayer ref={containerRef} isMobile={isMobile} className="max-w-[640px] max-h-64">
    <div className="flex shrink-0 items-center gap-2 px-3 py-1">
      <span className="min-w-0 flex-1 text-[length:calc(var(--text-meta)*0.875)] leading-4 text-muted-foreground">{t('assistants.contact.sessionMention.scope')}</span>
      <Button type="button" size="xs" variant="ghost" aria-label={t('dialog.common.actions.close')} onClick={onClose}><Icon name="close" className="size-4" /></Button>
    </div>
    {result.isPending ? <p role="status" className="px-3 py-2 typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {result.isError ? <div role="alert" className="px-3 py-2 typography-meta text-[var(--status-error)]">
      {t('assistants.contact.sessionMention.loadFailed')}
      <Button type="button" variant="ghost" size="sm" onClick={() => void result.refetch()}>{t('chat.history.retry')}</Button>
    </div> : null}
    {result.isSuccess && !sessions.length ? <p role="status" className="px-3 py-2 typography-meta text-muted-foreground">
      {t(result.data === null ? 'common.unavailable' : 'sessions.sidebar.empty.noMatches.title')}
    </p> : null}
    <ScrollableOverlay preventOverscroll outerClassName="flex-1 min-h-0" className="px-0">
      <div id={listId} role="listbox" aria-label={t('chat.fileMentionAutocomplete.groups.sessions')} className="p-1.5">
        {sessions.map((session, rowIndex) => <div
          key={`${session.directory}:${session.id}`} id={`${listId}-${rowIndex}`} role="option" aria-selected={rowIndex === index}
          ref={(node) => { rowRefs.current[rowIndex] = node; }}
          className={cn('flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 typography-ui-label', composerAutocompleteRowClassName(isMobile, rowIndex === index))}
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => setHighlight({ query, index: rowIndex })}
          onPointerDown={(event) => { if (event.pointerType === 'touch') touch.pointerDown(event.clientX, event.clientY); }}
          onPointerMove={(event) => { if (event.pointerType === 'touch') touch.pointerMove(event.clientX, event.clientY); }}
          onPointerUp={(event) => {
            if (event.pointerType === 'touch' && touch.pointerUp(() => onSelect(session))) { event.preventDefault(); event.stopPropagation(); }
          }}
          onPointerCancel={() => touch.pointerCancel()}
          onClick={() => touch.click(() => onSelect(session))}
        >
          <Icon name="chat-thread" className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium leading-5" title={session.title}>{session.title || t('chat.fileMentionAutocomplete.untitledSession')}</div>
            <div className="truncate text-[length:calc(var(--text-meta)*0.875)] leading-4 text-muted-foreground" title={session.directory}>{session.directory}</div>
          </div>
        </div>)}
      </div>
    </ScrollableOverlay>
    {!isMobile ? <div className="mx-1.5 shrink-0 border-t px-1.5 py-1 text-[length:calc(var(--text-meta)*0.875)] leading-4 text-muted-foreground">{t('chat.autocomplete.keyboardHint')}</div> : null}
  </ComposerAutocompleteLayer>;
});

type Props = Omit<React.ComponentProps<typeof ChatPromptComposer>, 'onChange'> & {
  active: boolean;
  working?: boolean;
  onChange: (value: string) => void;
};

export const AssistantSessionComposer = ({ active, working = false, onChange, ...props }: Props) => {
  const { t } = useI18n();
  const [localDocument, setLocalDocument] = React.useState<{ canonical: string; document: ComposerDocument }>(() => ({
    canonical: props.value, document: materializeSessionMentionTokens(props.value, new Map()),
  }));
  // The contact draft API stays canonical; editing and painting share Chat's
  // authoritative reference ranges, codecs, and reserved icon slots.
  const document = React.useMemo(() => localDocument.canonical === props.value
    ? localDocument.document : materializeSessionMentionTokens(props.value, new Map()), [localDocument, props.value]);
  const [cursor, setCursor] = React.useState(0);
  const [dismissed, setDismissed] = React.useState(true);
  const [composing, setComposing] = React.useState(false);
  const [activeOptionId, setActiveOptionId] = React.useState<string>();
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const highlightRef = React.useRef<HTMLDivElement>(null);
  const pickerRef = React.useRef<PickerHandle>(null);
  const caretRef = React.useRef<number | null>(null);
  const historyRef = React.useRef(emptyComposerReferenceHistory());
  const listId = React.useId();
  const trigger = active && !props.pending && !props.disabled && !dismissed && !composing
    ? resolveComposerAutocompleteTrigger({ text: document.text, cursor }) : null;
  const mention = trigger?.kind === 'mention' ? trigger : null;
  React.useLayoutEffect(() => {
    if (caretRef.current === null) return;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.setSelectionRange(caretRef.current, caretRef.current);
    caretRef.current = null;
  }, [document]);
  const close = useEvent(() => setDismissed(true));
  const commit = useEvent((nextDocument: ComposerDocument, caret: number, recordHistory = true) => {
    const serialized = serializeComposerDocument(nextDocument);
    if (!serialized.ok) return;
    if (recordHistory) historyRef.current = pushComposerReferenceHistory(historyRef.current, {
      before: createComposerReferenceHistorySnapshot(document, [], { start: inputRef.current?.selectionStart ?? cursor, end: inputRef.current?.selectionEnd ?? cursor }),
      after: createComposerReferenceHistorySnapshot(nextDocument, [], { start: caret, end: caret }),
    });
    if (!composing) caretRef.current = caret;
    setCursor(caret);
    setLocalDocument({ canonical: serialized.text, document: nextDocument });
    onChange(serialized.text);
  });
  const select = useEvent((session: MentionSession) => {
    if (!mention) return;
    const title = session.title || t('chat.fileMentionAutocomplete.untitledSession');
    const inserted = insertComposerReference(document, mention.tokenStart, mention.tokenEnd, {
      id: `session:${session.id}:${crypto.randomUUID()}`, kind: 'session', sessionId: session.id,
      display: composerTriggerIconDisplay({ trigger: '@', icon: 'chat-thread', label: title }),
    }, { inlineBoundaries: true, padDocumentEdges: true });
    const caret = inserted.caret + (inserted.document.text[inserted.caret] === ' ' ? 1 : 0);
    setDismissed(true);
    commit(inserted.document, caret);
  });
  const copyReferenceSelection = useEvent((event: React.ClipboardEvent<HTMLTextAreaElement>, cut: boolean) => {
    const input = event.currentTarget;
    if (input.selectionStart === input.selectionEnd || !event.clipboardData
      || !document.references.some(reference => reference.start < input.selectionEnd && reference.end > input.selectionStart)) return;
    const range = expandComposerReferenceSelection(input.selectionStart, input.selectionEnd, document.references)
      ?? { start: input.selectionStart, end: input.selectionEnd };
    const copied = serializeComposerDocument({ text: document.text.slice(range.start, range.end),
      references: document.references.filter(reference => reference.start >= range.start && reference.end <= range.end)
        .map(reference => ({ ...reference, start: reference.start - range.start, end: reference.end - range.start })),
    });
    if (!copied.ok) return;
    event.preventDefault(); event.clipboardData.setData('text/plain', copied.text);
    if (cut) {
      const removed = reconcileComposerDocument(document, document.text.slice(0, range.start) + document.text.slice(range.end), range.start, range.start);
      commit(removed.document, removed.caret);
    }
  });
  const highlighted = React.useMemo(() => buildHighlightParts(document.text, document.references.map(reference => ({
    start: reference.start, end: reference.end, priority: 103, ...decorateComposerReference(reference),
  })))?.map((part, index) => <span key={`${index}-${part.text.length}`} className={part.className}>
    {part.visual ? <ComposerTriggerIconMark visual={part.visual} text={part.text} /> : part.text}
  </span>), [document]);
  return <ChatPromptComposer {...props} value={document.text} pending={props.pending || working}
    disableInputWhilePending={props.pending === true} inputRef={inputRef}
    highlightedContent={highlighted} highlightRef={highlightRef}
    textLayoutClassName={cn('whitespace-pre-wrap break-words overflow-hidden px-3 typography-markdown md:typography-ui-label', props.layout === 'inline' ? 'py-3 leading-6' : 'pt-4 pb-2', props.textLayoutClassName)}
    onChange={(value, event) => {
      const next = reconcileComposerDocument(document, value, event?.target.selectionStart ?? value.length, event?.target.selectionEnd ?? value.length);
      commit(next.document, next.caret);
      setDismissed((event?.nativeEvent as InputEvent | undefined)?.inputType === 'insertFromPaste');
    }}
    textareaProps={{ ...props.textareaProps,
      'aria-controls': mention ? listId : undefined,
      'aria-activedescendant': mention ? activeOptionId : undefined,
      'aria-autocomplete': 'list',
      onScroll: (event) => {
        props.textareaProps?.onScroll?.(event);
        if (highlightRef.current) {
          highlightRef.current.scrollTop = event.currentTarget.scrollTop;
          highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
        }
      },
      onCopy: (event) => { props.textareaProps?.onCopy?.(event); if (!event.defaultPrevented) copyReferenceSelection(event, false); },
      onCut: (event) => { props.textareaProps?.onCut?.(event); if (!event.defaultPrevented) copyReferenceSelection(event, true); },
      onSelect: (event) => { setCursor(event.currentTarget.selectionStart); props.textareaProps?.onSelect?.(event); },
      onCompositionStart: () => { setComposing(true); },
      onCompositionEnd: (event) => { setComposing(false); setCursor(event.currentTarget.selectionStart); },
      onKeyDown: (event) => {
        props.textareaProps?.onKeyDown?.(event);
        if (event.defaultPrevented || isIMECompositionEvent(event)) return;
        if (composing) { if (event.key === 'Enter') event.preventDefault(); return; }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
          const restored = event.shiftKey ? redoComposerReferenceHistory(historyRef.current, document) : undoComposerReferenceHistory(historyRef.current, document);
          if (restored) {
            event.preventDefault(); historyRef.current = restored.history;
            commit(restored.snapshot.document, restored.snapshot.selection.end, false); setDismissed(true);
          }
          return;
        }
        if (event.key === 'Backspace' || event.key === 'Delete') {
          const removed = resolveComposerReferenceDeletion(document, { key: event.key,
            selectionStart: event.currentTarget.selectionStart, selectionEnd: event.currentTarget.selectionEnd, altKey: event.altKey });
          if (removed) { event.preventDefault(); commit(removed.document, removed.caret); setDismissed(true); return; }
        }
        if (mention && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); pickerRef.current?.keyDown(event.key);
        }
      },
    }}
  >
    {mention ? <SessionMentionPicker ref={pickerRef} query={mention.query} isMobile={props.isMobile ?? false} listId={listId} onHighlightChange={setActiveOptionId} onSelect={select} onClose={close} /> : null}
  </ChatPromptComposer>;
};
