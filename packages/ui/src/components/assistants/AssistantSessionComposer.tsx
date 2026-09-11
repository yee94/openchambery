import React from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import { useQuery } from '@tanstack/react-query';
import { ChatPromptComposer } from '@/components/chat/ChatPromptComposer';
import { ComposerAutocompleteLayer } from '@/components/chat/ComposerAutocompleteLayer';
import { composerAutocompleteRowClassName } from '@/components/chat/composerAutocompleteChrome';
import { createMentionTouchSelectionController } from '@/components/chat/fileMentionTouchSelection';
import { getSessionMentionToken, getVisibleSessionMentionCandidates } from '@/components/chat/fileMentionAutocompleteState';
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
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="flex-1 typography-meta text-muted-foreground">{t('assistants.contact.sessionMention.scope')}</span>
      <Button type="button" size="icon" variant="ghost" aria-label={t('dialog.common.actions.close')} onClick={onClose}><Icon name="close" className="size-4" /></Button>
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
      <div id={listId} role="listbox" aria-label={t('chat.fileMentionAutocomplete.groups.sessions')} className="pb-2">
        {sessions.map((session, rowIndex) => <div
          key={`${session.directory}:${session.id}`} id={`${listId}-${rowIndex}`} role="option" aria-selected={rowIndex === index}
          ref={(node) => { rowRefs.current[rowIndex] = node; }}
          className={cn('flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 typography-ui-label', composerAutocompleteRowClassName(isMobile, rowIndex === index))}
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
            <div className="truncate" title={session.title}>{session.title || t('chat.fileMentionAutocomplete.untitledSession')}</div>
            <div className="truncate typography-meta text-muted-foreground" title={session.directory}>{session.directory}</div>
          </div>
        </div>)}
      </div>
    </ScrollableOverlay>
    {!isMobile ? <div className="border-t px-3 py-1.5 typography-meta text-muted-foreground">{t('chat.autocomplete.keyboardHint')}</div> : null}
  </ComposerAutocompleteLayer>;
});

type Props = Omit<React.ComponentProps<typeof ChatPromptComposer>, 'onChange'> & {
  active: boolean;
  working?: boolean;
  onChange: (value: string) => void;
};

export const AssistantSessionComposer = ({ active, working = false, onChange, ...props }: Props) => {
  const { t } = useI18n();
  const [cursor, setCursor] = React.useState(0);
  const [dismissed, setDismissed] = React.useState(true);
  const [composing, setComposing] = React.useState(false);
  const [activeOptionId, setActiveOptionId] = React.useState<string>();
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const pickerRef = React.useRef<PickerHandle>(null);
  const caretRef = React.useRef<number | null>(null);
  const listId = React.useId();
  const trigger = active && !props.pending && !props.disabled && !dismissed && !composing
    ? resolveComposerAutocompleteTrigger({ text: props.value, cursor }) : null;
  const mention = trigger?.kind === 'mention' ? trigger : null;
  React.useLayoutEffect(() => {
    if (caretRef.current === null) return;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.setSelectionRange(caretRef.current, caretRef.current);
    caretRef.current = null;
  }, [props.value]);
  const close = useEvent(() => setDismissed(true));
  const select = useEvent((session: MentionSession) => {
    if (!mention) return;
    const title = session.title || t('chat.fileMentionAutocomplete.untitledSession');
    const reference = `@${getSessionMentionToken(session.id)} ${JSON.stringify({ title, sessionID: session.id, directory: session.directory })} `;
    const next = props.value.slice(0, mention.tokenStart) + reference + props.value.slice(mention.tokenEnd);
    caretRef.current = mention.tokenStart + reference.length;
    setCursor(caretRef.current);
    setDismissed(true);
    onChange(next);
  });
  return <ChatPromptComposer {...props} pending={props.pending || working}
    disableInputWhilePending={props.pending === true} inputRef={inputRef}
    onChange={(value, event) => {
      onChange(value);
      setCursor(event?.target.selectionStart ?? value.length);
      setDismissed((event?.nativeEvent as InputEvent | undefined)?.inputType === 'insertFromPaste');
    }}
    textareaProps={{ ...props.textareaProps,
      'aria-controls': mention ? listId : undefined,
      'aria-activedescendant': mention ? activeOptionId : undefined,
      'aria-autocomplete': 'list',
      onSelect: (event) => { setCursor(event.currentTarget.selectionStart); props.textareaProps?.onSelect?.(event); },
      onCompositionStart: () => { setComposing(true); },
      onCompositionEnd: (event) => { setComposing(false); setCursor(event.currentTarget.selectionStart); },
      onKeyDown: (event) => {
        props.textareaProps?.onKeyDown?.(event);
        if (event.defaultPrevented || isIMECompositionEvent(event)) return;
        if (composing) { if (event.key === 'Enter') event.preventDefault(); return; }
        if (mention && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); pickerRef.current?.keyDown(event.key);
        }
      },
    }}
  >
    {mention ? <SessionMentionPicker ref={pickerRef} query={mention.query} isMobile={props.isMobile ?? false} listId={listId} onHighlightChange={setActiveOptionId} onSelect={select} onClose={close} /> : null}
  </ChatPromptComposer>;
};
