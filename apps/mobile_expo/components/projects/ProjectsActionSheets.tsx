import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';

import { Text } from '@/components/Themed';
import { useConnection } from '@/context/ConnectionContext';
import type { ActiveRuntime } from '@/lib/connectionController';
import { createDirectory, getFilesystemHome, listFilesystem, type FilesystemEntry } from '@/lib/fsApi';
import { createGitWorktree, deleteGitWorktree } from '@/lib/gitWorktreesApi';
import { t } from '@/lib/i18n';
import { discoverProjectIcon } from '@/lib/projectIconApi';
import {
  PROJECT_COLOR_HEX,
  PROJECT_COLOR_KEYS,
  PROJECT_ICON_KEYS,
  type ProjectColorKey,
  type ProjectIconKey,
} from '@/lib/projectMeta';
import type { ProjectsHomeProjectItem, ProjectsHomeWorktreeGroup } from '@/lib/projectsHomeModel';
import {
  buildProjectEntry,
  type ProjectEntry,
} from '@/lib/projectsSettingsApi';
import Colors from '@/constants/Colors';

type ActionSheetProps = {
  visible: boolean;
  title: string;
  onClose: () => void;
  dark: boolean;
  children: React.ReactNode;
};

function ActionSheet({ visible, title, onClose, dark, children }: ActionSheetProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: dark ? Colors.dark.card : Colors.light.card }]}
          onPress={(e) => e.stopPropagation?.()}
        >
          <Text style={styles.sheetTitle}>{title}</Text>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export type ProjectOverflowTarget =
  | { kind: 'project'; project: ProjectsHomeProjectItem }
  | { kind: 'worktree'; project: ProjectsHomeProjectItem; worktree: ProjectsHomeWorktreeGroup }
  | null;

export function ProjectOverflowSheet({
  target,
  dark,
  tint,
  onClose,
  onNewSession,
  onNewWorktree,
  onEditProject,
  onCloseProject,
  onDeleteWorktree,
}: {
  target: ProjectOverflowTarget;
  dark: boolean;
  tint: string;
  onClose: () => void;
  onNewSession: () => void;
  onNewWorktree: () => void;
  onEditProject: () => void;
  onCloseProject: () => void;
  onDeleteWorktree: () => void;
}) {
  if (!target) return null;
  const title =
    target.kind === 'project' ? target.project.name : target.worktree.name;
  const rows =
    target.kind === 'project'
      ? [
          { key: 'newSession', label: t('mobile.projects.actions.newSession'), onPress: onNewSession },
          ...(target.project.isGitRepository
            ? [{ key: 'newWorktree', label: t('mobile.projects.actions.newWorktree'), onPress: onNewWorktree }]
            : []),
          { key: 'edit', label: t('mobile.projects.actions.edit'), onPress: onEditProject },
          {
            key: 'close',
            label: t('mobile.projects.actions.closeProject'),
            onPress: onCloseProject,
            destructive: true,
          },
        ]
      : [
          { key: 'newSession', label: t('mobile.projects.actions.newSession'), onPress: onNewSession },
          {
            key: 'deleteWorktree',
            label: t('mobile.projects.actions.deleteWorktree'),
            onPress: onDeleteWorktree,
            destructive: true,
          },
        ];

  return (
    <ActionSheet visible={!!target} title={title} onClose={onClose} dark={dark}>
      {rows.map((row) => (
        <Pressable
          key={row.key}
          accessibilityRole="button"
          onPress={() => {
            onClose();
            row.onPress();
          }}
          style={styles.row}
        >
          <Text style={[styles.rowLabel, row.destructive ? { color: '#ef4444' } : null]}>
            {row.label}
          </Text>
        </Pressable>
      ))}
      <Pressable accessibilityRole="button" onPress={onClose} style={styles.row}>
        <Text style={[styles.rowLabel, { color: tint }]}>{t('mobile.projects.actions.cancel')}</Text>
      </Pressable>
    </ActionSheet>
  );
}

export function NewProjectSheet({
  visible,
  dark,
  tint,
  existing,
  onClose,
  onCreated,
}: {
  visible: boolean;
  dark: boolean;
  tint: string;
  existing: ProjectEntry[];
  onClose: () => void;
  onCreated: (projects: ProjectEntry[]) => Promise<void> | void;
}) {
  const { state } = useConnection();
  const active = state.active;
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FilesystemEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (nextPath: string) => {
      if (!active) return;
      setLoading(true);
      setError(null);
      try {
        const listed = await listFilesystem(active, nextPath || undefined);
        setEntries(listed.filter((entry) => entry.isDirectory));
        setPath(nextPath);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('mobile.projects.newProject.listFailed'));
      } finally {
        setLoading(false);
      }
    },
    [active],
  );

  useEffect(() => {
    if (!visible || !active) return;
    void (async () => {
      try {
        const home = await getFilesystemHome(active);
        await load(home ?? '');
      } catch {
        await load('');
      }
    })();
  }, [active, load, visible]);

  const parentPath = useMemo(() => {
    const normalized = path.replace(/\/+$/, '');
    if (!normalized || normalized === '/') return '';
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0) return '/';
    return normalized.slice(0, idx) || '/';
  }, [path]);

  const submit = useCallback(async () => {
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (active) {
        try {
          await createDirectory(active, path.trim());
        } catch {
          // Directory may already exist — still allow adding the project.
        }
      }
      const entry = buildProjectEntry(path.trim());
      const next = [...existing.filter((p) => p.path !== entry.path), entry];
      await onCreated(next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mobile.projects.newProject.createFailed'));
    } finally {
      setBusy(false);
    }
  }, [active, existing, onClose, onCreated, path]);

  return (
    <ActionSheet
      visible={visible}
      title={t('mobile.projects.newProject.title')}
      onClose={onClose}
      dark={dark}
    >
      <Text style={styles.hint}>{t('mobile.projects.newProject.hint')}</Text>
      <TextInput
        value={path}
        onChangeText={setPath}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="/path/to/project"
        placeholderTextColor="#71717a"
        style={[styles.input, { color: dark ? '#fff' : '#111', borderColor: '#3f3f46' }]}
      />
      <RNView style={styles.rowActions}>
        <Pressable
          accessibilityRole="button"
          disabled={!parentPath && path === ''}
          onPress={() => void load(parentPath)}
          style={styles.chip}
        >
          <Text style={styles.chipLabel}>{t('mobile.projects.newProject.up')}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => void load(path)}
          style={styles.chip}
        >
          <Text style={styles.chipLabel}>{t('mobile.projects.newProject.refresh')}</Text>
        </Pressable>
      </RNView>
      {loading ? <ActivityIndicator color={tint} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView style={styles.list}>
        {entries.map((entry) => (
          <Pressable
            key={entry.path}
            accessibilityRole="button"
            onPress={() => void load(entry.path)}
            style={styles.row}
          >
            <Text style={styles.rowLabel} numberOfLines={1}>
              {entry.name}/
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        disabled={busy || !path.trim()}
        onPress={() => void submit()}
        style={[styles.primary, { backgroundColor: tint, opacity: busy || !path.trim() ? 0.5 : 1 }]}
      >
        <Text style={styles.primaryLabel}>{t('mobile.projects.newProject.add')}</Text>
      </Pressable>
    </ActionSheet>
  );
}

export function NewWorktreeSheet({
  visible,
  dark,
  tint,
  project,
  onClose,
  onCreated,
}: {
  visible: boolean;
  dark: boolean;
  tint: string;
  project: ProjectsHomeProjectItem | null;
  onClose: () => void;
  onCreated: (worktreePath: string) => Promise<void> | void;
}) {
  const { state } = useConnection();
  const active = state.active;
  const [branchName, setBranchName] = useState('');
  const [worktreeName, setWorktreeName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setBranchName('');
    setWorktreeName('');
    setError(null);
  }, [visible]);

  const submit = useCallback(async () => {
    if (!active || !project || !branchName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createGitWorktree(active, project.path, {
        mode: 'new',
        branchName: branchName.trim(),
        worktreeName: worktreeName.trim() || branchName.trim(),
      });
      await onCreated(created.path);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mobile.projects.newWorktree.failed'));
    } finally {
      setBusy(false);
    }
  }, [active, branchName, onClose, onCreated, project, worktreeName]);

  return (
    <ActionSheet
      visible={visible && !!project}
      title={t('mobile.projects.newWorktree.title')}
      onClose={onClose}
      dark={dark}
    >
      <Text style={styles.hint}>{project?.path}</Text>
      <TextInput
        value={branchName}
        onChangeText={setBranchName}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={t('mobile.projects.newWorktree.branchPlaceholder')}
        placeholderTextColor="#71717a"
        style={[styles.input, { color: dark ? '#fff' : '#111', borderColor: '#3f3f46' }]}
      />
      <TextInput
        value={worktreeName}
        onChangeText={setWorktreeName}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={t('mobile.projects.newWorktree.namePlaceholder')}
        placeholderTextColor="#71717a"
        style={[styles.input, { color: dark ? '#fff' : '#111', borderColor: '#3f3f46' }]}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy || !branchName.trim()}
        onPress={() => void submit()}
        style={[styles.primary, { backgroundColor: tint, opacity: busy || !branchName.trim() ? 0.5 : 1 }]}
      >
        <Text style={styles.primaryLabel}>{t('mobile.projects.newWorktree.create')}</Text>
      </Pressable>
    </ActionSheet>
  );
}

export function ProjectEditSheet({
  visible,
  dark,
  tint,
  project,
  entry,
  onClose,
  onSave,
}: {
  visible: boolean;
  dark: boolean;
  tint: string;
  project: ProjectsHomeProjectItem | null;
  entry: ProjectEntry | null;
  onClose: () => void;
  onSave: (patch: { label: string; icon: string | null; color: string | null }) => Promise<void> | void;
}) {
  const { state } = useConnection();
  const active = state.active;
  const [label, setLabel] = useState('');
  const [icon, setIcon] = useState<ProjectIconKey | null>(null);
  const [color, setColor] = useState<ProjectColorKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setLabel(entry?.label || project?.name || '');
    setIcon((entry?.icon as ProjectIconKey | null) ?? null);
    setColor((entry?.color as ProjectColorKey | null) ?? null);
    setError(null);
  }, [entry, project, visible]);

  const submit = useCallback(async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ label: label.trim() || project.name, icon, color });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mobile.projects.edit.failed'));
    } finally {
      setBusy(false);
    }
  }, [color, icon, label, onClose, onSave, project]);

  const discover = useCallback(async () => {
    if (!active || !project) return;
    setBusy(true);
    setError(null);
    try {
      const result = await discoverProjectIcon(active, project.id, { force: true });
      if (!result.ok) setError(result.error || t('mobile.projects.edit.discoverFailed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mobile.projects.edit.discoverFailed'));
    } finally {
      setBusy(false);
    }
  }, [active, project]);

  return (
    <ActionSheet
      visible={visible && !!project}
      title={t('mobile.projects.edit.title')}
      onClose={onClose}
      dark={dark}
    >
      <TextInput
        value={label}
        onChangeText={setLabel}
        placeholder={t('mobile.projects.edit.namePlaceholder')}
        placeholderTextColor="#71717a"
        style={[styles.input, { color: dark ? '#fff' : '#111', borderColor: '#3f3f46' }]}
      />
      <Text style={styles.section}>{t('mobile.projects.edit.icon')}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
        {PROJECT_ICON_KEYS.map((key) => (
          <Pressable
            key={key}
            onPress={() => setIcon(key)}
            style={[styles.chip, icon === key ? { borderColor: tint, borderWidth: 2 } : null]}
          >
            <Text style={styles.chipLabel}>{key}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Text style={styles.section}>{t('mobile.projects.edit.color')}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
        {PROJECT_COLOR_KEYS.map((key) => (
          <Pressable
            key={key}
            onPress={() => setColor(key)}
            style={[
              styles.colorDot,
              { backgroundColor: PROJECT_COLOR_HEX[key] },
              color === key ? { borderColor: '#fff', borderWidth: 2 } : null,
            ]}
          />
        ))}
      </ScrollView>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void discover()} style={styles.chip}>
        <Text style={styles.chipLabel}>{t('mobile.projects.edit.discover')}</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => void submit()}
        style={[styles.primary, { backgroundColor: tint, opacity: busy ? 0.5 : 1 }]}
      >
        <Text style={styles.primaryLabel}>{t('mobile.projects.edit.save')}</Text>
      </Pressable>
    </ActionSheet>
  );
}

export async function removeWorktreeAction(
  active: ActiveRuntime,
  projectPath: string,
  worktreePath: string,
): Promise<void> {
  await deleteGitWorktree(active, projectPath, { directory: worktreePath });
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 28,
    maxHeight: '80%',
    gap: 8,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  hint: {
    fontSize: 13,
    opacity: 0.7,
  },
  section: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 4,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  row: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(127,127,127,0.25)',
  },
  rowLabel: {
    fontSize: 16,
    fontWeight: '500',
  },
  rowActions: {
    flexDirection: 'row',
    gap: 8,
  },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(127,127,127,0.15)',
    marginRight: 8,
  },
  chipLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  chips: {
    maxHeight: 44,
  },
  colorDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    marginRight: 8,
  },
  list: {
    maxHeight: 220,
  },
  primary: {
    marginTop: 8,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryLabel: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
  },
  error: {
    color: '#ef4444',
    fontSize: 13,
  },
});
