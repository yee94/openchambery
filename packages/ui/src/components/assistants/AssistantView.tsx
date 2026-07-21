import React from 'react';
import { useEvent } from '@reactuses/core';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { createUuid } from '@/lib/uuid';
import { cn } from '@/lib/utils';
import {
  archiveAssistantTopic,
  createAssistantTopic,
  renameAssistantTopic,
  runAssistantTopicOperation,
  useAssistantSnapshotQuery,
  useAssistantTopicsQuery,
  useAssistantTurnsQuery,
  type AssistantPart,
  type AssistantTopicDTO,
} from '@/queries/assistantQueries';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useAssistantUIStore } from '@/stores/useAssistantUIStore';
import { useUIStore } from '@/stores/useUIStore';

type PendingSend = { operationID: string; operation: 'message' | 'new' | 'compact'; parts: AssistantPart[]; error: boolean };

const readImage = (file: File): Promise<AssistantPart> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve({ type: 'file', mime: file.type, url: String(reader.result) });
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

const textFromParts = (parts: AssistantPart[]): string => parts.filter((part): part is Extract<AssistantPart, { type: 'text' }> => part.type === 'text').map((part) => part.text).join('\n');

export const AssistantView: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const transport = getRuntimeTransportIdentity();
  const snapshotQuery = useAssistantSnapshotQuery();
  const snapshot = snapshotQuery.data;
  const selectedAssistantID = useAssistantUIStore((state) => state.assistantByTransport[transport] ?? null);
  const selectedTopicID = useAssistantUIStore((state) => state.topicByTransport[transport] ?? null);
  const selectAssistant = useAssistantUIStore((state) => state.selectAssistant);
  const selectTopic = useAssistantUIStore((state) => state.selectTopic);
  const topicsQuery = useAssistantTopicsQuery(selectedAssistantID);
  const [pending, setPending] = React.useState<PendingSend | null>(null);
  const turnsQuery = useAssistantTurnsQuery(selectedTopicID);
  const [draft, setDraft] = React.useState('');
  const [attachments, setAttachments] = React.useState<AssistantPart[]>([]);
  const [topicDraft, setTopicDraft] = React.useState('');
  const [editingTopic, setEditingTopic] = React.useState<AssistantTopicDTO | null>(null);
  const [topicActionError, setTopicActionError] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  const providers = useConfigStore((state) => state.providers);

  const assistant = snapshot?.assistants.find((item) => item.id === selectedAssistantID) ?? null;
  const topics = topicsQuery.data ?? [];
  const topic = topics.find((item) => item.id === selectedTopicID) ?? null;
  const configured = assistant ? providers.length === 0 || providers.some((provider) => provider.id === assistant.providerID && provider.models?.some((model) => model.id === assistant.modelID)) : true;
  const canSend = Boolean(snapshot?.enabled && assistant?.enabled && configured && topic && !pending);

  React.useEffect(() => {
    if (!isMobile && !selectedAssistantID && snapshot?.assistants[0]) selectAssistant(snapshot.assistants[0].id);
  }, [isMobile, selectAssistant, selectedAssistantID, snapshot?.assistants]);

  React.useEffect(() => {
    if (snapshotQuery.isSuccess && selectedAssistantID && !assistant) {
      selectAssistant(isMobile ? null : (snapshot?.assistants[0]?.id ?? null));
    }
  }, [assistant, isMobile, selectAssistant, selectedAssistantID, snapshot?.assistants, snapshotQuery.isSuccess]);

  React.useEffect(() => {
    if (!isMobile && selectedAssistantID && topicsQuery.isSuccess && !selectedTopicID) {
      const inbox = topics.find((item) => item.id === assistant?.inboxTopicID);
      selectTopic(inbox?.id ?? topics[0]?.id ?? null);
    }
  }, [assistant?.inboxTopicID, isMobile, selectTopic, selectedAssistantID, selectedTopicID, topics, topicsQuery.isSuccess]);

  React.useEffect(() => {
    if (topicsQuery.isSuccess && selectedTopicID && !topic) {
      selectTopic(isMobile ? null : (assistant?.inboxTopicID ?? topics[0]?.id ?? null));
    }
  }, [assistant?.inboxTopicID, isMobile, selectTopic, selectedTopicID, topic, topics, topicsQuery.isSuccess]);

  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [pending, turnsQuery.data]);

  const submit = useEvent(async (retry?: PendingSend) => {
    if (!topic) return;
    const trimmed = draft.trim();
    let operation: 'message' | 'new' | 'compact' = retry?.operation ?? 'message';
    if (!retry && trimmed.startsWith('/')) {
      if (trimmed === '/new') operation = 'new';
      else if (trimmed === '/compact') operation = 'compact';
      else {
        setPending({ operationID: '', operation: 'message', parts: [{ type: 'text', text: trimmed }], error: true });
        return;
      }
    }
    const parts = retry?.parts ?? [...(trimmed && operation === 'message' ? [{ type: 'text' as const, text: trimmed }] : []), ...attachments];
    if (operation === 'message' && parts.length === 0) return;
    const operationID = retry?.operationID || createUuid();
    setPending({ operationID, operation, parts, error: false });
    if (!retry) {
      setDraft('');
      setAttachments([]);
    }
    try {
      await runAssistantTopicOperation(topic.id, operationID, operation, parts);
      setPending(null);
    } catch {
      setPending({ operationID, operation, parts, error: true });
    }
  });

  const addImages = useEvent(async (files: FileList | null) => {
    if (!files) return;
    const images = Array.from(files).filter((file) => file.type.startsWith('image/'));
    const parts = await Promise.all(images.map(readImage));
    setAttachments((current) => [...current, ...parts].slice(0, 8));
  });

  const createTopic = useEvent(async () => {
    if (!assistant || !topicDraft.trim()) return;
    setTopicActionError(false);
    try {
      const created = await createAssistantTopic(assistant.id, topicDraft.trim());
      setTopicDraft('');
      selectTopic(created.id);
    } catch {
      setTopicActionError(true);
    }
  });

  const commitRename = useEvent(async () => {
    if (!editingTopic || !topicDraft.trim()) return;
    setTopicActionError(false);
    try {
      await renameAssistantTopic(editingTopic, topicDraft.trim());
      setEditingTopic(null);
      setTopicDraft('');
    } catch {
      setTopicActionError(true);
    }
  });

  const archiveTopic = useEvent(async (target: AssistantTopicDTO) => {
    setTopicActionError(false);
    try {
      await archiveAssistantTopic(target);
      if (selectedTopicID === target.id) selectTopic(assistant?.inboxTopicID ?? null);
    } catch {
      setTopicActionError(true);
    }
  });

  const assistantRail = (
    <aside className="flex h-full min-h-0 flex-col bg-sidebar md:border-r md:border-border">
      <div className="px-4 pb-2 pt-5">
        <div className="flex items-center gap-2">
          {isMobile ? <Button variant="ghost" size="icon" onClick={() => useUIStore.getState().setActiveMainTab('chat')} aria-label={t('assistants.actions.backToChat')}><Icon name="arrow-left-s" className="size-5" /></Button> : null}
          <span className="flex size-8 items-center justify-center rounded-lg bg-interactive-selection"><Icon name="ai-agent" className="size-4" /></span>
          <div>
            <h1 className="typography-ui-header font-semibold">{t('assistants.title')}</h1>
            <p className="typography-micro text-muted-foreground">{t('assistants.subtitle')}</p>
          </div>
        </div>
      </div>
      {snapshotQuery.isError && snapshot ? <div className="mx-3 my-2 rounded-md border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 px-3 py-2 typography-meta text-[var(--status-warning)]">{t('assistants.state.staleSnapshot')}</div> : null}
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {snapshot?.assistants.map((item) => (
          <button key={item.id} type="button" onClick={() => selectAssistant(item.id)} className={cn('group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors', item.id === selectedAssistantID ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover')}>
            <AgentAvatar name={item.id} size={30} label={item.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate typography-ui-label font-medium">{item.name}</span>
              <span className="block truncate typography-micro text-muted-foreground">{item.mode === 'continuous' ? t('assistants.mode.continuous') : t('assistants.mode.stateless')}</span>
            </span>
            {!item.enabled ? <Icon name="pause" className="size-4 text-[var(--status-warning)]" /> : <Icon name="arrow-right-s" className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />}
          </button>
        ))}
      </div>
      {!snapshot?.assistants.length ? <div className="px-5 pb-8 text-center typography-ui text-muted-foreground">{t('assistants.empty')}</div> : null}
    </aside>
  );

  const topicRail = (
    <aside className="flex h-full min-h-0 flex-col border-r border-border bg-[var(--surface-muted)]">
      <div className="flex items-center gap-2 border-b border-border px-3 py-3">
        {isMobile ? <Button variant="ghost" size="icon" onClick={() => selectAssistant(null)} aria-label={t('assistants.actions.backToAssistants')}><Icon name="arrow-left-s" className="size-5" /></Button> : null}
        <AgentAvatar name={assistant?.id} size={24} />
        <span className="min-w-0 flex-1 truncate typography-ui-label font-medium">{assistant?.name}</span>
      </div>
      <div className="p-3">
        <div className="flex gap-2">
          <Input value={topicDraft} onChange={(event) => setTopicDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void (editingTopic ? commitRename() : createTopic()); } }} placeholder={editingTopic ? t('assistants.topics.renamePlaceholder') : t('assistants.topics.newPlaceholder')} className="h-8" />
          <Button size="icon" variant={editingTopic ? 'outline' : 'default'} onClick={() => void (editingTopic ? commitRename() : createTopic())} aria-label={editingTopic ? t('assistants.topics.rename') : t('assistants.topics.create')}><Icon name={editingTopic ? 'check' : 'add'} className="size-4" /></Button>
        </div>
        {topicActionError ? <p className="mt-2 typography-meta text-[var(--status-error)]">{t('assistants.topics.actionFailed')}</p> : null}
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {topicsQuery.isPending ? <div className="p-4 text-center text-muted-foreground"><Icon name="loader-4" className="mx-auto size-4 animate-spin" /></div> : null}
        {topicsQuery.isError && topics.length === 0 ? <button type="button" onClick={() => void topicsQuery.refetch()} className="w-full p-4 text-center typography-meta text-[var(--status-error)]">{t('assistants.actions.retry')}</button> : null}
        {topics.map((item) => {
          const inbox = item.id === assistant?.inboxTopicID;
          return (
            <div key={item.id} className={cn('group flex items-center rounded-md transition-colors', item.id === selectedTopicID ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover')}>
              <button type="button" onClick={() => selectTopic(item.id)} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left">
                <Icon name={inbox ? 'inbox-archive' : 'chat-thread'} className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate typography-ui-label">{inbox ? t('assistants.topics.inbox') : item.title}</span>
              </button>
              {!inbox ? (
                <div className="flex pr-1 opacity-100 md:opacity-0 md:group-hover:opacity-100">
                  <Button variant="ghost" size="icon" onClick={() => { setEditingTopic(item); setTopicDraft(item.title); }} aria-label={t('assistants.topics.rename')}><Icon name="edit" className="size-3.5" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => void archiveTopic(item)} aria-label={t('assistants.topics.archive')}><Icon name="archive" className="size-3.5" /></Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </aside>
  );

  const conversation = (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 md:px-5">
        {isMobile ? <Button variant="ghost" size="icon" onClick={() => selectTopic(null)} aria-label={t('assistants.actions.backToTopics')}><Icon name="arrow-left-s" className="size-5" /></Button> : null}
        <div className="min-w-0 flex-1">
          <div className="truncate typography-ui-label font-medium">{topic?.id === assistant?.inboxTopicID ? t('assistants.topics.inbox') : topic?.title}</div>
          <div className="typography-micro text-muted-foreground">{assistant?.mode === 'stateless' ? t('assistants.conversation.statelessHint') : t('assistants.conversation.continuousHint')}</div>
        </div>
        {pending && !pending.error ? <span className="flex items-center gap-1.5 typography-meta text-muted-foreground"><Icon name="loader-4" className="size-3.5 animate-spin" />{t('assistants.state.sending')}</span> : null}
      </header>

      {!snapshot?.enabled || !assistant?.enabled || !configured ? (
        <div className="border-b border-border bg-[var(--status-warning)]/10 px-4 py-2.5 typography-meta text-[var(--status-warning)]">
          {!snapshot?.enabled ? t('assistants.state.instanceDisabled') : !assistant?.enabled ? t('assistants.state.assistantDisabled') : t('assistants.state.invalidConfiguration')}
        </div>
      ) : null}
      {turnsQuery.isError && turnsQuery.data ? <div className="border-b border-border px-4 py-2 typography-meta text-[var(--status-warning)]">{t('assistants.state.staleSnapshot')}</div> : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <div className="mx-auto max-w-3xl space-y-8">
          {turnsQuery.isPending ? <div className="flex justify-center py-12 text-muted-foreground"><Icon name="loader-4" className="size-5 animate-spin" /></div> : null}
          {turnsQuery.isError && !turnsQuery.data ? <div className="py-12 text-center"><p className="typography-ui text-muted-foreground">{t('assistants.state.messagesFailed')}</p><Button className="mt-3" variant="outline" size="sm" onClick={() => void turnsQuery.refetch()}>{t('assistants.actions.retry')}</Button></div> : null}
          {turnsQuery.data?.map((turn) => (
            <article key={turn.id} className="group flex items-start gap-3">
              {turn.role === 'assistant' ? <AgentAvatar name={assistant?.id} size={28} label={assistant?.name} /> : turn.kind === 'compact' ? <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-interactive-selection"><Icon name="contract-up-down" className="size-4" /></span> : <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface-elevated)]"><Icon name="user-3" className="size-4" /></span>}
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="mb-1 flex items-center gap-2 typography-meta font-medium"><span>{turn.role === 'assistant' ? assistant?.name : t('assistants.conversation.you')}</span>{typeof turn.createdAt === 'number' ? <span className="font-normal text-muted-foreground">{new Date(turn.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}</div>
                {textFromParts(turn.parts) ? <SimpleMarkdownRenderer content={textFromParts(turn.parts)} /> : null}
                <div className="mt-2 flex flex-wrap gap-2">{turn.parts.filter((part): part is Extract<AssistantPart, { type: 'file' }> => part.type === 'file').map((part) => <img key={part.url} src={part.url} alt={t('assistants.composer.attachment')} className="max-h-64 max-w-full rounded-lg border border-border object-contain" />)}</div>
                {turn.role === 'assistant' && turn.error ? <p className="mt-2 typography-meta text-[var(--status-error)]">{String(turn.error)}</p> : null}
              </div>
            </article>
          ))}
          {!turnsQuery.isPending && !turnsQuery.data?.length ? <div className="py-16 text-center"><AgentAvatar name={assistant?.id} size={48} className="mx-auto" /><h2 className="mt-4 typography-ui-header font-medium">{t('assistants.conversation.emptyTitle', { name: assistant?.name ?? '' })}</h2><p className="mt-1 typography-ui text-muted-foreground">{t('assistants.conversation.emptyDescription')}</p></div> : null}
          {pending ? (
            <div className={cn('rounded-lg border px-4 py-3', pending.error ? 'border-[var(--status-error)]/40 bg-[var(--status-error)]/10' : 'border-border bg-[var(--surface-muted)]')}>
              <div className="flex items-center gap-2 typography-meta"><Icon name={pending.error ? 'error-warning' : 'loader-4'} className={cn('size-4', !pending.error && 'animate-spin')} /><span>{pending.error ? (pending.operationID ? t('assistants.state.sendFailed') : t('assistants.composer.commandUnavailable')) : t('assistants.state.reconciling')}</span>{pending.error && pending.operationID ? <Button variant="outline" size="xs" className="ml-auto" onClick={() => void submit(pending)}>{t('assistants.actions.retry')}</Button> : null}</div>
            </div>
          ) : null}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="shrink-0 bg-gradient-to-t from-background via-background to-transparent px-3 pb-[max(12px,var(--oc-safe-area-bottom,0px))] pt-3 md:px-8 md:pb-5">
        <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-[var(--surface-elevated)] shadow-lg shadow-black/5 focus-within:ring-2 focus-within:ring-[var(--interactive-focus-ring)]">
          {attachments.length ? <div className="flex gap-2 overflow-x-auto px-3 pt-3">{attachments.map((part, index) => part.type === 'file' ? <div key={`${part.url}-${index}`} className="group relative shrink-0"><img src={part.url} alt={t('assistants.composer.attachment')} className="size-16 rounded-lg border border-border object-cover" /><Button variant="secondary" size="icon" className="absolute -right-1 -top-1 size-6 opacity-90" onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={t('assistants.composer.removeAttachment')}><Icon name="close" className="size-3" /></Button></div> : null)}</div> : null}
          <Textarea simple value={draft} onChange={(event) => { setDraft(event.target.value); if (pending?.operationID === '') setPending(null); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }} disabled={!canSend} placeholder={canSend ? t('assistants.composer.placeholder') : t('assistants.composer.disabledPlaceholder')} className="min-h-16 max-h-40 px-4 pt-3" />
          <div className="flex items-center gap-2 px-3 pb-3">
            <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => { void addImages(event.target.files); event.target.value = ''; }} />
            <Button variant="ghost" size="icon" onClick={() => fileInputRef.current?.click()} disabled={!canSend} aria-label={t('assistants.composer.addImage')}><Icon name="file-image" className="size-4" /></Button>
            <span className="min-w-0 flex-1 truncate typography-micro text-muted-foreground">{t('assistants.composer.commandsHint')}</span>
            <Button size="icon" onClick={() => void submit()} disabled={!canSend || (!draft.trim() && !attachments.length)} aria-label={t('assistants.composer.send')}><Icon name="arrow-up" className="size-4" /></Button>
          </div>
        </div>
      </div>
    </section>
  );

  if (snapshotQuery.isPending) return <div className="flex h-full items-center justify-center text-muted-foreground"><Icon name="loader-4" className="size-5 animate-spin" /></div>;
  if (snapshotQuery.isError && !snapshot) return <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"><Icon name="cloud-off" className="size-7 text-muted-foreground" /><p className="typography-ui text-muted-foreground">{t('assistants.state.unavailable')}</p><Button variant="outline" size="sm" onClick={() => void snapshotQuery.refetch()}>{t('assistants.actions.retry')}</Button></div>;

  if (isMobile) {
    if (selectedAssistantID && selectedTopicID) return conversation;
    if (selectedAssistantID) return topicRail;
    return assistantRail;
  }

  return <div className="grid h-full min-h-0 grid-cols-[220px_260px_minmax(0,1fr)] overflow-hidden">{assistantRail}{topicRail}{conversation}</div>;
};
