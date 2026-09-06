import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, View as RNView } from 'react-native';

import {
  SettingsCard,
  SettingsErrorState,
  SettingsLoading,
  SettingsPageScaffold,
  settingsRowDivider,
  useSettingsTheme,
} from '@/components/settings/SettingsChrome';
import { Text } from '@/components/Themed';
import { useConnection } from '@/context/ConnectionContext';
import {
  loadProjectsSettings,
  projectLabelFromPath,
  type ProjectEntry,
} from '@/lib/projectsSettingsApi';
import { t } from '@/lib/i18n';

export function ProjectsSettingsPage({ onBack }: { onBack: () => void }) {
  const { state } = useConnection();
  const theme = useSettingsTheme();
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!state.active) {
      setError(t('settings.error.notConnected'));
      return;
    }
    setError(null);
    try {
      const slice = await loadProjectsSettings(state.active);
      setProjects(slice.projects);
    } catch (err) {
      setProjects(null);
      setError(err instanceof Error ? err.message : t('settings.error.loadFailed'));
    }
  }, [state.active]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <SettingsPageScaffold title={t('settings.pages.projects')} onBack={onBack}>
      <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
        {error ? (
          <SettingsErrorState message={error} onRetry={() => void reload()} />
        ) : projects == null ? (
          <SettingsLoading />
        ) : (
          <SettingsCard>
            {projects.map((project, index) => (
              <RNView
                key={project.id}
                style={[
                  { paddingHorizontal: 14, paddingVertical: 11, minHeight: 52 },
                  settingsRowDivider(theme.border, index === projects.length - 1),
                ]}
              >
                <Text style={{ color: theme.text, fontWeight: '600' }}>
                  {projectLabelFromPath(project.path, project.label)}
                </Text>
                <Text style={{ color: theme.muted, fontSize: 12 }}>{project.path}</Text>
              </RNView>
            ))}
            {projects.length === 0 ? (
              <RNView style={{ padding: 16 }}>
                <Text style={{ color: theme.muted, textAlign: 'center' }}>
                  {t('settings.projects.empty')}
                </Text>
              </RNView>
            ) : null}
          </SettingsCard>
        )}
      </ScrollView>
    </SettingsPageScaffold>
  );
}
