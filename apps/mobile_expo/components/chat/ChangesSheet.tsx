/**
 * Cap MobileChangesSurface subset — status list + per-file simple diff text.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View as RNView,
} from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { useConnection } from '@/context/ConnectionContext';
import {
  buildSimpleDiffLines,
  type SimpleDiffLine,
  isStagedGitFile,
  isUnstagedGitFile,
  loadGitFileDiff,
  loadGitStatus,
  type GitStatusFile,
} from '@/lib/gitChangesApi';
import { t } from '@/lib/i18n';

export type ChangesSheetProps = {
  visible: boolean;
  directory: string | null;
  initialDiffPath?: string | null;
  initialDiffStaged?: boolean;
  onClose: () => void;
};

type Route =
  | { type: 'list' }
  | { type: 'diff'; path: string; staged: boolean };

export function ChangesSheet({
  visible,
  directory,
  initialDiffPath,
  initialDiffStaged = false,
  onClose,
}: ChangesSheetProps) {
  const { state } = useConnection();
  const active = state.active;
  const textColor = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const [route, setRoute] = useState<Route>({ type: 'list' });
  const [files, setFiles] = useState<GitStatusFile[]>([]);
  const [branch, setBranch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffLines, setDiffLines] = useState<SimpleDiffLine[]>([]);

  useEffect(() => {
    if (!visible) return;
    if (initialDiffPath?.trim()) {
      setRoute({ type: 'diff', path: initialDiffPath.trim(), staged: initialDiffStaged });
    } else {
      setRoute({ type: 'list' });
      setDiffLines([]);
    }
  }, [visible, initialDiffPath, initialDiffStaged]);

  const refresh = useCallback(async () => {
    if (!active || !directory?.trim()) {
      setFiles([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const status = await loadGitStatus(active, directory, { mode: 'light' });
      setFiles(status.files);
      setBranch(status.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'status failed');
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [active, directory]);

  useEffect(() => {
    if (!visible || route.type !== 'list') return;
    void refresh();
  }, [visible, route, refresh]);

  useEffect(() => {
    if (!visible || route.type !== 'diff' || !active || !directory?.trim()) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadGitFileDiff(active, directory, route.path, { staged: route.staged })
      .then((diff) => {
        if (!cancelled) setDiffLines(buildSimpleDiffLines(diff));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'diff failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, route, active, directory]);

  const staged = useMemo(() => files.filter(isStagedGitFile), [files]);
  const unstaged = useMemo(() => files.filter(isUnstagedGitFile), [files]);

  const rows = useMemo(() => {
    const out:  { key: string; label: string; file?: GitStatusFile; staged?: boolean; header?: boolean }[] = [];
    if (staged.length) {
      out.push({ key: 'h-staged', label: t('mobile.chat.changes.staged'), header: true });
      for (const file of staged) {
        out.push({ key: `s:${file.path}`, label: file.path, file, staged: true });
      }
    }
    if (unstaged.length) {
      out.push({ key: 'h-unstaged', label: t('mobile.chat.changes.unstaged'), header: true });
      for (const file of unstaged) {
        out.push({ key: `u:${file.path}`, label: file.path, file, staged: false });
      }
    }
    return out;
  }, [staged, unstaged]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <RNView style={styles.root}>
        <RNView style={styles.header}>
          <Pressable
            onPress={() => {
              if (route.type === 'diff') setRoute({ type: 'list' });
              else onClose();
            }}
          >
            <Text style={styles.action}>{route.type === 'diff' ? '‹' : t('mobile.chat.changes.close')}</Text>
          </Pressable>
          <Text style={[styles.title, { color: textColor }]} numberOfLines={1}>
            {route.type === 'diff' ? route.path : `${t('mobile.chat.changes.title')}${branch ? ` · ${branch}` : ''}`}
          </Text>
          <Pressable onPress={onClose}>
            <Text style={styles.action}>{t('mobile.chat.changes.close')}</Text>
          </Pressable>
        </RNView>

        {loading ? <ActivityIndicator style={{ marginTop: 16 }} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {route.type === 'list' ? (
          <FlatList
            data={rows}
            keyExtractor={(item) => item.key}
            ListEmptyComponent={
              !loading ? <Text style={[styles.empty, { color: muted }]}>{t('mobile.chat.changes.empty')}</Text> : null
            }
            renderItem={({ item }) =>
              item.header ? (
                <Text style={[styles.section, { color: muted }]}>{item.label}</Text>
              ) : (
                <Pressable
                  style={styles.row}
                  onPress={() => {
                    if (!item.file) return;
                    setRoute({ type: 'diff', path: item.file.path, staged: Boolean(item.staged) });
                  }}
                >
                  <Text style={{ color: textColor }} numberOfLines={1}>
                    {item.label}
                  </Text>
                </Pressable>
              )
            }
          />
        ) : (
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {diffLines.length === 0 && !loading ? (
              <Text style={[styles.diff, { color: muted }]}>—</Text>
            ) : (
              diffLines.map((line, index) => (
                <Text
                  key={`${index}:${line.kind}:${line.text.slice(0, 24)}`}
                  style={[
                    styles.diff,
                    {
                      color:
                        line.kind === 'add'
                          ? '#16a34a'
                          : line.kind === 'del'
                            ? '#dc2626'
                            : line.kind === 'meta'
                              ? muted
                              : textColor,
                    },
                  ]}
                  selectable
                >
                  {line.text || ' '}
                </Text>
              ))
            )}
          </ScrollView>
        )}
      </RNView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 12 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  title: { flex: 1, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  action: { color: '#3b82f6', fontSize: 15, fontWeight: '600', minWidth: 48 },
  section: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6, fontSize: 12, fontWeight: '700' },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(127,127,127,0.25)',
  },
  empty: { textAlign: 'center', marginTop: 24 },
  error: { color: '#dc2626', paddingHorizontal: 16, marginTop: 8 },
  diff: { fontSize: 12, lineHeight: 18, fontFamily: 'Menlo' },
});
