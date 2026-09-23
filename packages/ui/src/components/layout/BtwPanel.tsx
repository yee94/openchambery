import React from 'react';
import { useEvent } from '@reactuses/core';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Button } from '@/components/ui/button';
import { MobileResizableSheet, MobileSheetHeaderActions } from '@/components/ui/MobileResizableSheet';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';
import { useUIStore } from '@/stores/useUIStore';
import { EMPTY_SESSION_BTW_ENTRY, getSessionBtwKey, useSessionBtwStore, type SessionBtwScope } from '@/stores/useSessionBtwStore';

export function BtwPanel({ scope, mobile = false }: { scope: SessionBtwScope; mobile?: boolean }) {
  const { t } = useI18n();
  const key = getSessionBtwKey(scope);
  const entry = useSessionBtwStore((state) => state.entries[key] ?? EMPTY_SESSION_BTW_ENTRY);
  const error = entry.error === 'empty response' || entry.error === 'session.btw failed'
    ? t('chat.btw.failed')
    : entry.error;
  const copy = useEvent(async () => {
    const result = await copyTextToClipboard(entry.answer);
    if (result.ok) toast.success(t('contextSidebar.actions.copied'));
    else toast.error(t('filesView.toast.copyFailed'));
  });
  const actions = <>
    <Button type="button" variant="ghost" size="sm" disabled={entry.pending || !entry.question}
      onClick={() => void useSessionBtwStore.getState().retry(scope)}>{t('contextPanel.preview.actions.retry')}</Button>
    <Button type="button" variant="ghost" size="sm" disabled={!entry.answer} onClick={copy}>
      {t('contextSidebar.actions.copy')}
    </Button>
  </>;
  return <section className="flex h-full min-h-0 min-w-0 flex-col text-foreground" aria-label={t('chat.btw.title')}>
    {mobile ? <MobileSheetHeaderActions>{actions}</MobileSheetHeaderActions> :
      <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border/40 px-3 py-2">{actions}</div>}
    <div key={`${key}\u0000${entry.question}`} className="overlay-scrollbar-container min-h-0 flex-1 overflow-y-auto overscroll-contain p-4" tabIndex={0}>
      <p className="mb-4 typography-meta text-muted-foreground">{t('chat.btw.description')}</p>
      {entry.question ? <h2 className="mb-4 whitespace-pre-wrap break-words typography-ui-header">{entry.question}</h2> :
        <p className="typography-ui-label text-muted-foreground">{t('chat.btw.questionRequired')}</p>}
      {entry.pending ? <p role="status" className="typography-ui-label text-muted-foreground">{t('chat.btw.pending')}</p> : null}
      {error ? <p role="alert" className="mb-3 whitespace-pre-wrap break-words typography-ui-label text-[var(--status-error)]">{error}</p> : null}
      {entry.answer ? <SimpleMarkdownRenderer content={entry.answer} enableFileReferences={false} /> : null}
      {entry.question && !entry.pending && !entry.error && !entry.answer ?
        <p role="status" className="typography-ui-label text-muted-foreground">{t('chat.btw.cancelled')}</p> : null}
    </div>
  </section>;
}

/** The composer owns request lifetime; panel presence and tab changes only own presentation. */
export function BtwComposerSurface({ scope, active, mobile }: { scope: SessionBtwScope; active: boolean; mobile: boolean }) {
  const { t } = useI18n();
  const { sessionId, directory: scopeDirectory } = scope;
  const key = getSessionBtwKey(scope);
  const directory = normalizeDirectoryKey(scopeDirectory);
  const hasQuestion = useSessionBtwStore((state) => Boolean(state.entries[key]?.question));
  const panel = useUIStore((state) => state.contextPanelByDirectory[directory]);
  const open = active && Boolean(panel?.isOpen && panel.tabs.find((tab) => tab.id === panel.activeTabId)?.mode === 'btw');
  const retained = Boolean(panel?.isOpen && panel.tabs.some((tab) => tab.mode === 'btw'));
  const previousPresentation = React.useRef({ key, retained });
  React.useEffect(() => {
    const capturedScope = { sessionId, directory: scopeDirectory };
    const previous = previousPresentation.current;
    previousPresentation.current = { key, retained };
    if (previous.key === key && previous.retained && !retained) useSessionBtwStore.getState().cancel(capturedScope);
  }, [key, retained, sessionId, scopeDirectory]);
  const lease = React.useRef<{ key: string; active: boolean } | null>(null);
  React.useEffect(() => {
    const capturedScope = { sessionId, directory: scopeDirectory };
    const owner = { key, active };
    lease.current = owner;
    if (!active) useSessionBtwStore.getState().cancel(capturedScope);
    return () => {
      const entry = useSessionBtwStore.getState().entries[key];
      // StrictMode's same-scope setup replaces the lease before this microtask.
      // An intervening ask replaces the entry, and retains ownership of that request.
      queueMicrotask(() => {
        const current = lease.current;
        if (current !== owner && current?.key === key && current.active) return;
        if (getSessionBtwKey(capturedScope) === key && useSessionBtwStore.getState().entries[key] === entry) {
          useSessionBtwStore.getState().cancel(capturedScope);
        }
      });
    };
  }, [key, active, sessionId, scopeDirectory]);
  const close = useEvent(() => {
    useSessionBtwStore.getState().cancel(scope);
    useUIStore.getState().closeContextPanel(directory);
  });
  return <>
    {active && hasQuestion ? <div className="chat-input-column flex justify-end pb-1">
      <Button type="button" variant="ghost" size="sm" onClick={() => useUIStore.getState().openContextPanelTab(directory, { mode: 'btw' })}>
        {t('chat.btw.title')}
      </Button>
    </div> : null}
    {mobile ? <MobileResizableSheet id="session-btw" open={open} onOpenChange={(next) => { if (!next) close(); }}
      title={t('chat.btw.title')} ariaLabel={t('chat.btw.title')} closeAriaLabel={t('gitView.common.close')} resizeAriaLabel={t('chat.btw.resize')}>
      <BtwPanel scope={scope} mobile />
    </MobileResizableSheet> : null}
  </>;
}
