import React, { useMemo, useState } from 'react';
import { useEvent } from '@reactuses/core';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';

export type UpdateDialogModel = {
  title: string;
  currentVersion?: string;
  version?: string;
  description?: string;
  methodLabel?: string;
  body?: string | null;
  hideChangelog?: boolean;
  dismissible?: boolean;
  status?: { kind: 'activity' | 'download'; label: string; detail?: string; progress?: number | null };
  error?: string | null;
  warning?: string;
  message?: string;
  notice?: string;
  fallbackCommand?: string;
  releaseLink?: { url: string; label: string };
  actions: Array<{ id: string; label: string; icon?: IconName; disabled?: boolean; loading?: boolean; variant?: 'default' | 'ghost' }>;
};

type ChangelogSection = {
  version: string;
  date: string;
  start: number;
  end: number;
  raw: string;
};

type ParsedChangelog =
  | { kind: 'raw'; title: string; content: string }
  | { kind: 'sections'; title: string; sections: Array<{ version: string; dateLabel: string; content: string }> };

function formatIsoDateForUI(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return new Intl.DateTimeFormat(getCurrentIntlLocale(), { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}

function stripChangelogHeading(sectionRaw: string): string {
  return sectionRaw.replace(/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}\s*\n?/, '').trim();
}

function processChangelogMentions(content: string): string {
  // Convert @username to markdown links so they can be styled via css
  return content.replace(/(^|[^a-zA-Z0-9])@([a-zA-Z0-9-]+)/g, '$1[@$2](https://github.com/$2)');
}

function compareSemverDesc(a: string, b: string): number {
  const pa = a.split('.').map((v) => Number.parseInt(v, 10));
  const pb = b.split('.').map((v) => Number.parseInt(v, 10));
  for (let i = 0; i < 3; i += 1) {
    const da = Number.isFinite(pa[i]) ? (pa[i] as number) : 0;
    const db = Number.isFinite(pb[i]) ? (pb[i] as number) : 0;
    if (da !== db) return db - da;
  }
  return 0;
}

function parseChangelogSections(body: string): ChangelogSection[] {
  const re = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/gm;
  const matches: Array<{ version: string; date: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) matches.push({ version: m[1] ?? '', date: m[2] ?? '', start: m.index });
  return matches.map((match, idx) => {
    const end = matches[idx + 1]?.start ?? body.length;
    return { version: match.version, date: match.date, start: match.start, end, raw: body.slice(match.start, end).trim() };
  });
}

/** Shared presentation only. Client/Host adapters own transport, state and actions. */
export function UpdateDialogView({ open, onOpenChange, model, onAction }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: UpdateDialogModel;
  onAction: (id: string) => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const handleOpenExternal = useEvent((url: string) => { void openExternalUrl(url); });
  const handleChangelogClick = useEvent((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const a = target.closest('a');
    if (a?.href) {
      e.preventDefault();
      e.stopPropagation();
      handleOpenExternal(a.href);
    }
  });
  const handleCopyCommand = useEvent(async () => {
    if (!model.fallbackCommand) return;
    const result = await copyTextToClipboard(model.fallbackCommand);
    if (result.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  });
  const changelog = useMemo<ParsedChangelog | null>(() => {
    const body = model.body?.trim();
    if (!body) return null;
    const sections = parseChangelogSections(body);
    if (!sections.length) return { kind: 'raw', title: t('updateDialog.changelog.title'), content: processChangelogMentions(body) };
    return {
      kind: 'sections', title: t('updateDialog.changelog.title'),
      sections: [...sections].sort((a, b) => compareSemverDesc(a.version, b.version)).map((section) => ({
        version: section.version, dateLabel: formatIsoDateForUI(section.date),
        content: processChangelogMentions(stripChangelogHeading(section.raw) || body),
      })),
    };
  }, [model.body, t]);
  return <Dialog open={open} onOpenChange={model.dismissible === false ? undefined : onOpenChange}>
    <DialogContent className="max-w-4xl gap-0 p-4 sm:p-5 bg-background border-[var(--interactive-border)]" showCloseButton={true}>
      {/* Header Section */}
      <div className="mb-3 pr-8 sm:mb-4">
        <DialogTitle className="flex items-center gap-2">
          <Icon name="download-cloud" className="h-5 w-5 text-[var(--primary-base)]" />
          <span className="font-semibold text-foreground">{model.title}</span>
        </DialogTitle>
        {/* Version Diff */}
        {(model.currentVersion || model.version) && <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-7 font-mono text-[11px] leading-4 tracking-[-0.01em] tabular-nums sm:text-xs">
          {model.currentVersion && <span className="text-muted-foreground/75">{model.currentVersion}</span>}
          {model.currentVersion && model.version && <span className="text-muted-foreground/40">→</span>}
          {model.version && <span className="font-medium text-[var(--primary-base)]">{model.version}</span>}
          {model.methodLabel && <span className="text-muted-foreground">· {model.methodLabel}</span>}
        </div>}
        {model.description && <DialogDescription className="mt-2">{model.description}</DialogDescription>}
      </div>
      {/* Content Body */}
      <div className="space-y-3 sm:space-y-4">
        {model.message && <p role="status" className="typography-ui-label text-muted-foreground">{model.message}</p>}
        {model.warning && <p className="typography-meta text-[var(--status-warning)]">{model.warning}</p>}
        {/* Web update progress */}
        {model.status?.kind === 'activity' && <div role="status" className="rounded-lg bg-[var(--surface-elevated)]/30 p-5 border border-[var(--surface-subtle)]">
          <div className="flex items-center gap-3">
            <Icon name="loader" className="h-5 w-5 animate-spin text-[var(--primary-base)]" />
            <div className="typography-ui-label text-foreground">{model.status.label}</div>
          </div>
          {model.status.detail && <p className="mt-2 text-xs text-muted-foreground">{model.status.detail}</p>}
        </div>}
        {/* Changelog Rendering */}
        {changelog && !model.hideChangelog && <section className="overflow-hidden rounded-xl border border-[var(--surface-subtle)] bg-[var(--surface-elevated)]/20">
          <div className="flex items-center gap-2 border-b border-[var(--surface-subtle)] px-3.5 py-2.5 sm:px-4 sm:py-3">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--primary-base)]" aria-hidden="true" />
            <h3 className="typography-ui-caption font-medium text-muted-foreground">{changelog.title}</h3>
          </div>
          <ScrollableOverlay className="max-h-[min(42dvh,22rem)] p-0 sm:max-h-[400px]" fillContainer={false}>
            {changelog.kind === 'raw' ? <div className="break-words p-3.5 text-[13px] leading-[1.65] text-foreground sm:p-4 sm:text-sm [&_.markdown-content]:leading-[1.65] [&_a]:!text-[var(--primary-base)] [&_a]:!no-underline [&_a:hover]:!underline" onClickCapture={handleChangelogClick}>
              <SimpleMarkdownRenderer content={changelog.content} disableLinkSafety={true} enableFileReferences={false} />
            </div> : <div className="divide-y divide-[var(--surface-subtle)]">
              {changelog.sections.map((section) => <div key={section.version} className="p-3.5 sm:p-4">
                <div className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 sm:mb-3">
                  <span className="rounded-md bg-[var(--primary-base)]/10 px-1.5 py-0.5 font-mono text-[11px] font-medium leading-4 text-[var(--primary-base)] tabular-nums sm:text-xs">v{section.version}</span>
                  <span className="text-[11px] leading-4 text-muted-foreground/75 sm:text-xs">{section.dateLabel}</span>
                </div>
                <div className="break-words text-[13px] leading-[1.65] text-foreground sm:text-sm [&_.markdown-content]:leading-[1.65] [&_a]:!text-[var(--primary-base)] [&_a]:!no-underline [&_a:hover]:!underline" onClickCapture={handleChangelogClick}>
                  <SimpleMarkdownRenderer content={section.content} disableLinkSafety={true} enableFileReferences={false} />
                </div>
              </div>)}
            </div>}
          </ScrollableOverlay>
        </section>}
        {/* Web runtime fallback command */}
        {model.fallbackCommand && <div className="space-y-2 mt-4">
          <div className="flex items-center gap-2 typography-meta text-muted-foreground"><Icon name="terminal" className="h-4 w-4" /><span>{t('updateDialog.fallback.updateViaTerminal')}</span></div>
          <div className="flex items-center gap-2 p-1 pl-3 bg-[var(--surface-elevated)]/50 rounded-md border border-[var(--surface-subtle)]">
            <code className="flex-1 font-mono text-sm text-foreground overflow-x-auto whitespace-nowrap">{model.fallbackCommand}</code>
            <button onClick={handleCopyCommand} className={cn('flex items-center justify-center p-2 rounded', 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]', 'transition-colors', copied && 'text-[var(--status-success)]')} title={copied ? t('updateDialog.actions.copied') : t('updateDialog.actions.copyCommand')}>
              <Icon name={copied ? 'check' : 'clipboard'} className="h-4 w-4" />
            </button>
          </div>
        </div>}
        {/* Desktop / in-app mobile OTA progress bar */}
        {model.status?.kind === 'download' && <div role="status" className="mt-3 space-y-2 rounded-lg border border-[var(--surface-subtle)] bg-[var(--surface-elevated)]/20 px-3.5 py-3 sm:mt-4 sm:px-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground sm:text-[13px]">{model.status.label}</span>
            {model.status.progress != null && <span className="shrink-0 font-mono text-[11px] leading-4 text-foreground tabular-nums sm:text-xs">{Math.round(model.status.progress)}%</span>}
          </div>
          {model.status.progress != null && <div className="h-1 overflow-hidden rounded-full bg-[var(--surface-subtle)] sm:h-1.5"><div className="h-full rounded-full bg-[var(--primary-base)] transition-all duration-300" style={{ width: `${model.status.progress}%` }} /></div>}
          {model.status.detail && <p className="text-xs text-muted-foreground">{model.status.detail}</p>}
        </div>}
        {/* Error display */}
        {model.error && <div role="alert" className="p-3 mt-4 bg-[var(--status-error-background)] border border-[var(--status-error-border)] rounded-lg"><p className="text-sm text-[var(--status-error)]">{model.error}</p></div>}
      </div>
      {model.notice && <div className="mt-4 flex items-center gap-2 rounded-lg border border-[var(--status-success-border)] bg-[var(--status-success-background)] px-3 py-2.5 text-sm text-[var(--status-success)]"><Icon name="check" className="h-4 w-4 shrink-0" /><span>{model.notice}</span></div>}
      {/* Action Footer */}
      <div className="mt-4 flex items-center justify-between gap-4">
        {model.releaseLink ? <a href={model.releaseLink.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 typography-ui-label text-muted-foreground hover:text-foreground transition-colors shrink-0"><Icon name="external-link" className="h-4 w-4" />{model.releaseLink.label}</a> : <span />}
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          {model.actions.map((action) => <Button key={action.id} onClick={() => onAction(action.id)} disabled={action.disabled} variant={action.variant ?? 'default'} size="default">
            {action.icon && <Icon name={action.icon} className={cn('h-4 w-4', action.loading && 'animate-spin')} />}
            {action.label}
          </Button>)}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
