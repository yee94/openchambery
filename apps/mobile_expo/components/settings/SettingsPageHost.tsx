import React from 'react';

import { AssistantsSettingsPage } from '@/components/settings/pages/AssistantsSettingsPage';
import {
  AppearanceSettingsPage,
  BehaviorSettingsPage,
  ChatSettingsPage,
  GitSettingsPage,
  NotificationsSettingsPage,
  SessionsSettingsPage,
  SummaryAiSettingsPage,
} from '@/components/settings/pages/BlobEditors';
import {
  AgentsSettingsPage,
  CommandsSettingsPage,
  MagicPromptsSettingsPage,
  McpSettingsPage,
  PluginsSettingsPage,
  ProvidersSettingsPage,
  SkillsSettingsPage,
  SnippetsSettingsPage,
  UsageSettingsPage,
} from '@/components/settings/pages/CatalogPages';
import { AboutSettingsPage } from '@/components/settings/pages/AboutSettingsPage';
import { InstancesSettingsPage } from '@/components/settings/pages/InstancesSettingsPage';
import { ProjectsSettingsPage } from '@/components/settings/pages/ProjectsSettingsPage';
import type { SettingsPageSlug } from '@/lib/settings/metadata';

export function SettingsPageHost({
  slug,
  onBack,
  assistantId,
  create,
}: {
  slug: SettingsPageSlug;
  onBack: () => void;
  assistantId?: string;
  create?: boolean;
}) {
  switch (slug) {
    case 'instances':
      return <InstancesSettingsPage onBack={onBack} />;
    case 'appearance':
      return <AppearanceSettingsPage onBack={onBack} />;
    case 'chat':
      return <ChatSettingsPage onBack={onBack} />;
    case 'notifications':
      return <NotificationsSettingsPage onBack={onBack} />;
    case 'sessions':
      return <SessionsSettingsPage onBack={onBack} />;
    case 'summary-ai':
      return <SummaryAiSettingsPage onBack={onBack} />;
    case 'projects':
      return <ProjectsSettingsPage onBack={onBack} />;
    case 'git':
      return <GitSettingsPage onBack={onBack} />;
    case 'providers':
      return <ProvidersSettingsPage onBack={onBack} />;
    case 'agents':
      return <AgentsSettingsPage onBack={onBack} />;
    case 'assistants':
      return (
        <AssistantsSettingsPage onBack={onBack} assistantId={assistantId} create={create} />
      );
    case 'behavior':
      return <BehaviorSettingsPage onBack={onBack} />;
    case 'commands':
      return <CommandsSettingsPage onBack={onBack} />;
    case 'mcp':
      return <McpSettingsPage onBack={onBack} />;
    case 'plugins':
      return <PluginsSettingsPage onBack={onBack} />;
    case 'magic-prompts':
      return <MagicPromptsSettingsPage onBack={onBack} />;
    case 'snippets':
      return <SnippetsSettingsPage onBack={onBack} />;
    case 'skills.installed':
      return <SkillsSettingsPage onBack={onBack} />;
    case 'usage':
      return <UsageSettingsPage onBack={onBack} />;
    case 'about':
      return <AboutSettingsPage onBack={onBack} />;
    default:
      return null;
  }
}
