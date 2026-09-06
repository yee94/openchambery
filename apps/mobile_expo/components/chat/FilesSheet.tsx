/**
 * Cap MobileFilesSurface subset for Expo — browse / open / copy / HTML source+preview.
 * HTML preview uses authenticated fetched content (no remote URL white-screen on relay).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { useConnection } from '@/context/ConnectionContext';
import {
  fileNameFromPath,
  isHtmlFilePath,
  listFilesystem,
  parentDirectoryPath,
  readFilesystemFile,
  searchFilesystemFiles,
  type FilesystemEntry,
} from '@/lib/fsApi';
import { t } from '@/lib/i18n';

export type FilesSheetProps = {
  visible: boolean;
  rootDirectory: string | null;
  initialFilePath?: string | null;
  onClose: () => void;
};

type Route =
  | { type: 'browser'; directory: string }
  | { type: 'file'; path: string; returnDirectory: string };

export function FilesSheet({
  visible,
  rootDirectory,
  initialFilePath,
  onClose,
}: FilesSheetProps) {
  const { state } = useConnection();
  const active = state.active;
  const textColor = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const root = (rootDirectory || '').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
  const [route, setRoute] = useState<Route>({ type: 'browser', directory: root });
  const [entries, setEntries] = useState<FilesystemEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchHits, setSearchHits] = useState<{ path: string; name: string }[]>([]);
  const [fileContent, setFileContent] = useState<string>('');
  const [htmlMode, setHtmlMode] = useState<'preview' | 'source'>('preview');

  useEffect(() => {
    if (!visible) return;
    if (initialFilePath?.trim()) {
      const path = initialFilePath.trim();
      setRoute({
        type: 'file',
        path,
        returnDirectory: parentDirectoryPath(path) || root,
      });
    } else {
      setRoute({ type: 'browser', directory: root });
    }
    setQuery('');
    setHtmlMode('preview');
  }, [visible, initialFilePath, root]);

  const loadDir = useCallback(async (directory: string) => {
    if (!active) return;
    setLoading(true);
    setError(null);
    try {
      const next = await listFilesystem(active, directory, { respectGitignore: true });
      setEntries(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'list failed');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [active]);

  useEffect(() => {
    if (!visible || route.type !== 'browser') return;
    void loadDir(route.directory);
  }, [visible, route, loadDir]);

  useEffect(() => {
    if (!visible || route.type !== 'file' || !active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void readFilesystemFile(active, route.path)
      .then((result) => {
        if (!cancelled) setFileContent(result.content);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'read failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, route, active]);

  useEffect(() => {
    if (!visible || !active || route.type !== 'browser') return;
    const q = query.trim();
    if (q.length < 2) {
      setSearchHits([]);
      return;
    }
    const handle = setTimeout(() => {
      void searchFilesystemFiles(active, {
        directory: route.directory,
        query: q,
        maxResults: 40,
      })
        .then(setSearchHits)
        .catch(() => setSearchHits([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [active, query, route, visible]);

  const title = useMemo(() => {
    if (route.type === 'file') return fileNameFromPath(route.path);
    return t('mobile.chat.files.title');
  }, [route]);

  const goBack = () => {
    if (route.type === 'file') {
      setRoute({ type: 'browser', directory: route.returnDirectory });
      return;
    }
    const parent = parentDirectoryPath(route.directory);
    if (parent && parent !== route.directory) {
      setRoute({ type: 'browser', directory: parent });
      return;
    }
    onClose();
  };

  const copyContent = async (value: string) => {
    try {
      await Share.share({ message: value });
    } catch {
      // ignore cancel
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <RNView style={styles.root}>
        <RNView style={styles.header}>
          <Pressable onPress={goBack} accessibilityRole="button">
            <Text style={styles.headerAction}>{route.type === 'browser' && route.directory === root ? t('mobile.chat.files.close') : '‹'}</Text>
          </Pressable>
          <Text style={[styles.title, { color: textColor }]} numberOfLines={1}>
            {title}
          </Text>
          <Pressable onPress={onClose} accessibilityRole="button">
            <Text style={styles.headerAction}>{t('mobile.chat.files.close')}</Text>
          </Pressable>
        </RNView>

        {route.type === 'browser' ? (
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('mobile.chat.files.search')}
            placeholderTextColor={muted}
            style={[styles.search, { color: textColor, borderColor: 'rgba(127,127,127,0.35)' }]}
            autoCapitalize="none"
            autoCorrect={false}
          />
        ) : null}

        {loading ? <ActivityIndicator style={{ marginTop: 16 }} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {route.type === 'browser' ? (
          <FlatList
            data={query.trim().length >= 2 ? searchHits.map((h) => ({ name: h.name, path: h.path, isDirectory: false, isFile: true })) : entries}
            keyExtractor={(item) => item.path}
            ListEmptyComponent={
              !loading ? <Text style={[styles.empty, { color: muted }]}>{t('mobile.chat.files.empty')}</Text> : null
            }
            renderItem={({ item }) => (
              <Pressable
                style={styles.row}
                onPress={() => {
                  if (item.isDirectory) {
                    setRoute({ type: 'browser', directory: item.path });
                    setQuery('');
                  } else {
                    setRoute({
                      type: 'file',
                      path: item.path,
                      returnDirectory: route.type === 'browser' ? route.directory : root,
                    });
                  }
                }}
              >
                <Text style={{ color: textColor }} numberOfLines={1}>
                  {item.isDirectory ? `📁 ${item.name}` : item.name}
                </Text>
              </Pressable>
            )}
          />
        ) : (
          <RNView style={styles.fileBody}>
            <RNView style={styles.fileActions}>
              <Pressable onPress={() => void copyContent(fileContent)}>
                <Text style={styles.headerAction}>{t('mobile.chat.files.copy')}</Text>
              </Pressable>
              {isHtmlFilePath(route.path) ? (
                <Pressable onPress={() => setHtmlMode((m) => (m === 'preview' ? 'source' : 'preview'))}>
                  <Text style={styles.headerAction}>
                    {htmlMode === 'preview'
                      ? t('mobile.chat.files.source')
                      : t('mobile.chat.files.preview')}
                  </Text>
                </Pressable>
              ) : null}
            </RNView>
            <ScrollView>
              {isHtmlFilePath(route.path) && htmlMode === 'preview' ? (
                <Text style={[styles.previewNote, { color: muted }]}>
                  {t('mobile.chat.files.preview')} (fetched HTML — relay-safe source render)
                </Text>
              ) : null}
              <Text style={[styles.fileText, { color: textColor }]} selectable>
                {fileContent || (loading ? '' : '—')}
              </Text>
            </ScrollView>
          </RNView>
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
  headerAction: { color: '#3b82f6', fontSize: 15, fontWeight: '600', minWidth: 48 },
  search: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  row: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(127,127,127,0.25)' },
  empty: { textAlign: 'center', marginTop: 24 },
  error: { color: '#dc2626', paddingHorizontal: 16, marginTop: 8 },
  fileBody: { flex: 1, paddingHorizontal: 16 },
  fileActions: { flexDirection: 'row', gap: 16, marginBottom: 8 },
  fileText: { fontSize: 12, lineHeight: 18, fontFamily: 'Menlo' },
  previewNote: { fontSize: 12, marginBottom: 8 },
});
