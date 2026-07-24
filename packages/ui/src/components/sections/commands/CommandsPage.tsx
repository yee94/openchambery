import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useCommandsQuery, type CommandConfig, type CommandScope } from '@/queries/commandQueries';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { useShallow } from 'zustand/react/shallow';
import { ModelSelector } from '../agents/ModelSelector';
import { AgentSelector } from './AgentSelector';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { SettingsField, SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';

export const CommandsPage: React.FC = () => {
  const { t } = useI18n();
  const {
    selectedCommandName,
    createCommand,
    updateCommand,
    commandDraft,
    setCommandDraft,
  } = useCommandsStore(useShallow((s) => ({
    selectedCommandName: s.selectedCommandName,
    createCommand: s.createCommand,
    updateCommand: s.updateCommand,
    commandDraft: s.commandDraft,
    setCommandDraft: s.setCommandDraft,
  })));

  const commandsQuery = useCommandsQuery();
  const commands = React.useMemo(() => commandsQuery.data ?? [], [commandsQuery.data]);
  const selectedCommand = selectedCommandName ? commands.find((command) => command.name === selectedCommandName) : null;
  const isNewCommand = Boolean(commandDraft && commandDraft.name === selectedCommandName && !selectedCommand);

  const [draftName, setDraftName] = React.useState('');
  const [draftScope, setDraftScope] = React.useState<CommandScope>('user');
  const [description, setDescription] = React.useState('');
  const [agent, setAgent] = React.useState('');
  const [model, setModel] = React.useState('');
  const [template, setTemplate] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);
  const initialStateRef = React.useRef<{
    draftName: string;
    draftScope: CommandScope;
    description: string;
    agent: string;
    model: string;
    template: string;
  } | null>(null);

  React.useEffect(() => {
    if (isNewCommand && commandDraft) {
      const draftNameValue = commandDraft.name || '';
      const draftScopeValue = commandDraft.scope || 'user';
      const descriptionValue = commandDraft.description || '';
      const agentValue = commandDraft.agent || '';
      const modelValue = commandDraft.model || '';
      const templateValue = commandDraft.template || '';
      setDraftName(draftNameValue);
      setDraftScope(draftScopeValue);
      setDescription(descriptionValue);
      setAgent(agentValue);
      setModel(modelValue);
      setTemplate(templateValue);

      initialStateRef.current = {
        draftName: draftNameValue,
        draftScope: draftScopeValue,
        description: descriptionValue,
        agent: agentValue,
        model: modelValue,
        template: templateValue,
      };
    } else if (selectedCommand) {
      const descriptionValue = selectedCommand.description || '';
      const agentValue = selectedCommand.agent || '';
      const modelValue = selectedCommand.model || '';
      const templateValue = selectedCommand.template || '';
      setDescription(descriptionValue);
      setAgent(agentValue);
      setModel(modelValue);
      setTemplate(templateValue);

      initialStateRef.current = {
        draftName: '',
        draftScope: 'user',
        description: descriptionValue,
        agent: agentValue,
        model: modelValue,
        template: templateValue,
      };
    }
  }, [selectedCommand, isNewCommand, selectedCommandName, commands, commandDraft]);

  const isDirty = React.useMemo(() => {
    const initial = initialStateRef.current;
    if (!initial) {
      return false;
    }

    if (isNewCommand) {
      if (draftName !== initial.draftName) return true;
      if (draftScope !== initial.draftScope) return true;
    }

    if (description !== initial.description) return true;
    if (agent !== initial.agent) return true;
    if (model !== initial.model) return true;
    if (template !== initial.template) return true;
    return false;
  }, [agent, description, draftName, draftScope, isNewCommand, model, template]);

  const handleSave = async () => {
    const commandName = isNewCommand ? draftName.trim().replace(/\s+/g, '-') : selectedCommandName?.trim();
    
    if (!commandName) {
      toast.error(t('settings.commands.sidebar.toast.commandNameRequired'));
      return;
    }

    if (!template.trim()) {
      toast.error(t('settings.commands.page.toast.templateRequired'));
      return;
    }

    if (isNewCommand && commands.some((cmd) => cmd.name === commandName)) {
      toast.error(t('settings.commands.sidebar.toast.commandExists'));
      return;
    }

    setIsSaving(true);

    try {
      const trimmedAgent = agent.trim();
      const trimmedModel = model.trim();
      const trimmedTemplate = template.trim();
      const config: CommandConfig = {
        name: commandName,
        description: description.trim() || undefined,
        agent: trimmedAgent === '' ? null : trimmedAgent,
        model: trimmedModel === '' ? null : trimmedModel,
        template: trimmedTemplate,
        scope: isNewCommand ? draftScope : undefined,
      };

      let success: boolean;
      if (isNewCommand) {
        success = await createCommand(config);
        if (success) {
          setCommandDraft(null); 
        }
      } else {
        success = await updateCommand(commandName, config);
      }

      if (success) {
        toast.success(isNewCommand ? t('settings.commands.page.toast.created') : t('settings.commands.page.toast.updated'));
      } else {
        toast.error(isNewCommand ? t('settings.commands.page.toast.createFailed') : t('settings.commands.page.toast.updateFailed'));
      }
    } catch (error) {
      console.error('Error saving command:', error);
      toast.error(t('settings.commands.page.toast.saveUnexpectedError'));
    } finally {
      setIsSaving(false);
    }
  };

  if (!selectedCommandName) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="terminal-box" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.commands.page.empty.title')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.commands.page.empty.description')}</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="oc-settings-page-content mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header */}
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {isNewCommand ? t('settings.commands.page.title.new') : `/${selectedCommandName}`}
            </h2>
            <p className="typography-meta text-muted-foreground truncate">
              {isNewCommand ? t('settings.commands.page.subtitle.new') : t('settings.commands.page.subtitle.edit')}
            </p>
          </div>
        </div>

        {/* Identity */}
        <SettingsGroup label={t('settings.commands.page.section.identity')}>

            {isNewCommand && (
              <SettingsRow itemId="commands.name" label={t('settings.commands.page.field.commandName')}>
                  <div className="flex items-center">
                    <span className="typography-ui-label text-muted-foreground mr-1">/</span>
                    <Input
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder={t('settings.commands.page.field.commandNamePlaceholder')}
                      className="h-7 w-40 px-2"
                    />
                  </div>
                  <Select value={draftScope} onValueChange={(v) => setDraftScope(v as CommandScope)}>
                    <SelectTrigger className="w-fit min-w-[100px]">
                      <SelectValue placeholder={t('settings.agents.page.field.scopePlaceholder')} />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="user">
                        <div className="flex items-center gap-2">
                          <Icon name="user-3" className="h-3.5 w-3.5" />
                          <span>{t('settings.common.scope.global')}</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="project">
                        <div className="flex items-center gap-2">
                          <Icon name="folder" className="h-3.5 w-3.5" />
                          <span>{t('settings.common.scope.project')}</span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
              </SettingsRow>
            )}

            <SettingsRow label={t('settings.common.field.description')} className="oc-settings-split-row-stacked">
                <Textarea
                  embedded
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('settings.commands.page.field.descriptionPlaceholder')}
                  rows={2}
                  className="w-full resize-none min-h-[60px] bg-transparent"
                />
            </SettingsRow>
        </SettingsGroup>

        {/* Execution Context */}
        <SettingsGroup label={t('settings.commands.page.section.executionContext')}>

            <SettingsRow
              itemId="commands.agent"
              label={t('settings.commands.page.field.overrideAgent')}
            >
              <AgentSelector
                agentName={agent}
                onChange={(agentName: string) => setAgent(agentName)}
                className="oc-settings-inline-value"
              />
            </SettingsRow>

            <SettingsRow
              itemId="commands.model"
              label={t('settings.agents.page.field.overrideModel')}
            >
              <ModelSelector
                providerId={parseModelIdentifier(model)?.providerId ?? ''}
                modelId={parseModelIdentifier(model)?.modelId ?? ''}
                onChange={(providerId: string, modelId: string) => {
                  if (providerId && modelId) {
                    setModel(`${providerId}/${modelId}`);
                  } else {
                    setModel('');
                  }
                }}
                className="oc-settings-inline-value"
              />
            </SettingsRow>

        </SettingsGroup>

        {/* Command Template */}
        <SettingsField
          itemId="commands.template"
          label={t('settings.commands.page.section.template')}
          description={(
            <>
              <code className="text-foreground">$ARGUMENTS</code> {t('settings.commands.page.templateHint.userInput')} &middot;{' '}
              <code className="text-foreground">!`cmd`</code> {t('settings.commands.page.templateHint.shellOutput')} &middot;{' '}
              <code className="text-foreground">@file</code> {t('settings.commands.page.templateHint.fileContents')}
            </>
          )}
          descriptionPlacement="outside"
          className="oc-settings-split-row-stacked"
        >
            <Textarea
              embedded
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder={t('settings.commands.page.field.templatePlaceholder')}
              rows={12}
              className="w-full font-mono typography-meta min-h-[160px] max-h-[60vh] bg-transparent resize-y"
            />
        </SettingsField>

        {/* Save action */}
        <div className="px-2 py-1">
          <Button
            onClick={handleSave}
            disabled={isSaving || !isDirty}
            size="xs"
            className="!font-normal"
          >
            {isSaving ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}
          </Button>
        </div>

      </div>
    </ScrollableOverlay>
  );
};
