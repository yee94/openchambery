import React from 'react';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { languageByExtension } from '@/lib/codemirror/languageByExtension';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { shikiHighlightExtension } from '@/lib/codemirror/shikiHighlight';
import { getResolvedShikiTheme } from '@/lib/shiki/appThemeRegistry';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import type { Extension } from '@codemirror/state';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';

type ConfigTarget = 'opencode' | 'oh-my-opencode-slim' | 'oh-my-openagent';

const TARGET_LABELS: Record<ConfigTarget, string> = {
  opencode: 'OpenCode',
  'oh-my-opencode-slim': 'oh-my-opencode-slim',
  'oh-my-openagent': 'oh-my-openagent',
};

type AvailableTarget = { id: ConfigTarget; label: string; fileName: string };

async function readError(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof data?.error === 'string' && data.error.trim() ? data.error : fallback;
}

export function GlobalConfigPage() {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const [targets, setTargets] = React.useState<AvailableTarget[]>([]);
  const [target, setTarget] = React.useState<ConfigTarget | null>(null);
  const [content, setContent] = React.useState('');
  const [savedContent, setSavedContent] = React.useState('');
  const [fileName, setFileName] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isRestartDialogOpen, setIsRestartDialogOpen] = React.useState(false);
  const [isRestarting, setIsRestarting] = React.useState(false);

  const editorExtensions = React.useMemo<Extension[]>(() => {
    const editorFileName = fileName || 'opencode.json';
    const shikiLanguage = editorFileName.endsWith('.jsonc') ? 'jsonc' : 'json';
    const extensions: Extension[] = [createFlexokiCodeMirrorTheme(currentTheme, { syntaxColors: false })];
    const language = languageByExtension(editorFileName);
    if (language) {
      extensions.push(language);
    }
    extensions.push(shikiHighlightExtension({
      language: shikiLanguage,
      themeName: currentTheme.metadata.id,
      theme: getResolvedShikiTheme(currentTheme),
    }));
    return extensions;
  }, [currentTheme, fileName]);

  const load = React.useCallback(async (nextTarget: ConfigTarget) => {
    setIsLoading(true);
    try {
      const response = await runtimeFetch(`/api/config/global/${nextTarget}`);
      if (!response.ok) {
        throw new Error(await readError(response, t('settings.globalConfig.toast.loadFailed')));
      }
      const data = await response.json() as { content?: unknown; fileName?: unknown };
      const nextContent = typeof data.content === 'string' ? data.content : '';
      setContent(nextContent);
      setSavedContent(nextContent);
      setFileName(typeof data.fileName === 'string' ? data.fileName : '');
    } catch (error) {
      setContent('');
      setSavedContent('');
      setFileName('');
      toast.error(error instanceof Error ? error.message : t('settings.globalConfig.toast.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    let cancelled = false;
    const discover = async () => {
      setIsLoading(true);
      try {
        const response = await runtimeFetch('/api/config/global');
        if (!response.ok) {
          throw new Error(await readError(response, t('settings.globalConfig.toast.loadFailed')));
        }
        const data = await response.json() as { targets?: unknown };
        const availableTargets = Array.isArray(data.targets)
          ? data.targets.flatMap((entry): AvailableTarget[] => {
            if (!entry || typeof entry !== 'object') return [];
            const candidate = entry as { target?: unknown; fileName?: unknown };
            if (typeof candidate.target !== 'string' || typeof candidate.fileName !== 'string') return [];
            if (!(candidate.target in TARGET_LABELS)) return [];
            const id = candidate.target as ConfigTarget;
            return [{ id, label: TARGET_LABELS[id], fileName: candidate.fileName }];
          })
          : [];
        if (cancelled) return;
        setTargets(availableTargets);
        setTarget((current) => availableTargets.some((item) => item.id === current) ? current : (availableTargets[0]?.id || null));
      } catch (error) {
        if (!cancelled) {
          setTargets([]);
          setTarget(null);
          toast.error(error instanceof Error ? error.message : t('settings.globalConfig.toast.loadFailed'));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void discover();
    return () => { cancelled = true; };
  }, [t]);

  React.useEffect(() => {
    if (target) void load(target);
  }, [load, target]);

  const handleSave = async () => {
    if (!target) return;
    setIsSaving(true);
    try {
      const response = await runtimeFetch(`/api/config/global/${target}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!response.ok) {
        throw new Error(await readError(response, t('settings.globalConfig.toast.saveFailed')));
      }
      const data = await response.json() as { content?: unknown };
      const nextContent = typeof data.content === 'string' ? data.content : content;
      setContent(nextContent);
      setSavedContent(nextContent);
      toast.success(t('settings.globalConfig.toast.saved'));
      setIsRestartDialogOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.globalConfig.toast.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleRestart = async () => {
    setIsRestarting(true);
    try {
      await reloadOpenCodeConfiguration({
        message: t('settings.view.actions.reloadOpenCode'),
        mode: 'projects',
        scopes: ['all'],
      });
      setIsRestartDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.view.actions.reloadOpenCode'));
    } finally {
      setIsRestarting(false);
    }
  };

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="oc-settings-page-content mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
        <SettingsGroup
          itemId="global-config.editor"
          label={t('settings.globalConfig.title')}
          description={t('settings.globalConfig.description')}
          cardClassName="p-3"
        >
            {targets.length > 0 ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-1">
                  {targets.map((item) => (
                    <Button
                      key={item.id}
                      variant="chip"
                      size="xs"
                      aria-pressed={target === item.id}
                      onClick={() => setTarget(item.id)}
                    >
                      {item.label}
                    </Button>
                  ))}
                </div>
                <div className="flex min-w-0 items-center justify-between gap-3 px-1">
                  <span className="typography-meta truncate text-muted-foreground">{fileName}</span>
                  {target && (
                    <Button variant="ghost" size="xs" onClick={() => void load(target)} disabled={isLoading || isSaving}>
                      {t('settings.globalConfig.actions.reload')}
                    </Button>
                  )}
                </div>
                {target && (
                  <>
                    <div className="h-[clamp(420px,62dvh,760px)] overflow-hidden bg-background">
                      <CodeMirrorEditor
                        value={content}
                        onChange={setContent}
                        readOnly={isLoading}
                        extensions={editorExtensions}
                        className="h-full"
                        enableSearch
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button onClick={handleSave} disabled={isLoading || isSaving || content === savedContent} size="sm">
                        {isSaving ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}
                      </Button>
                      <p className="typography-meta text-muted-foreground">{t('settings.globalConfig.restartHint')}</p>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="min-h-12" aria-busy={isLoading} />
            )}
        </SettingsGroup>
      </div>
      <Dialog open={isRestartDialogOpen} onOpenChange={(open) => !isRestarting && setIsRestartDialogOpen(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.view.actions.reloadOpenCode')}</DialogTitle>
            <DialogDescription>{t('settings.globalConfig.restartHint')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setIsRestartDialogOpen(false)} disabled={isRestarting}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button size="sm" onClick={() => void handleRestart()} disabled={isRestarting}>
              {t('settings.view.actions.reloadOpenCode')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollableOverlay>
  );
}
