import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View as RNView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AssistantCard } from '@/components/assistant/AssistantCard';
import { AssistantDeleteConfirm } from '@/components/assistant/AssistantDeleteConfirm';
import { Text, View, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { useAssistantsCatalog } from '@/hooks/useAssistantsCatalog';
import { getAssistantPresentation } from '@/lib/assistantPresentation';
import type { AssistantDTO } from '@/lib/assistantsApi';
import { t } from '@/lib/i18n';

function openAssistantsSettings(router: ReturnType<typeof useRouter>, params?: Record<string, string>) {
  router.push({
    pathname: '/(tabs)/settings',
    params: { slug: 'assistants', ...params },
  });
}

export function AssistantCatalog() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  const tint = Colors[scheme].tint;
  const text = useThemeColor({}, 'text');
  const muted = dark ? 'rgba(250,250,250,0.55)' : 'rgba(24,24,27,0.55)';
  const surface = dark ? '#141414' : '#ffffff';
  const catalog = useAssistantsCatalog();
  const [deleteTarget, setDeleteTarget] = useState<AssistantDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await catalog.refresh();
    } finally {
      setRefreshing(false);
    }
  }, [catalog]);

  const handleOpen = useCallback(
    async (assistant: AssistantDTO) => {
      const binding = await catalog.openAssistantSession(assistant);
      if (!binding?.sessionID) return;
      router.push(`/chat/${encodeURIComponent(binding.sessionID)}`);
    },
    [catalog, router],
  );

  const handleEdit = useCallback(
    (assistant: AssistantDTO) => {
      openAssistantsSettings(router, { assistantId: assistant.id });
    },
    [router],
  );

  const handleCreate = useCallback(() => {
    openAssistantsSettings(router, { create: '1' });
  }, [router]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const ok = await catalog.removeAssistant(deleteTarget);
      if (ok) setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }, [catalog, deleteTarget, deleting]);

  const title = t('assistants.title');
  const refreshControl = (
    <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={tint} />
  );

  if (catalog.status === 'idle' || catalog.status === 'loading') {
    return (
      <View style={styles.root}>
        <RNView style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Text style={styles.title}>{title}</Text>
        </RNView>
        <RNView style={[styles.stateCard, { backgroundColor: surface }]}>
          <ActivityIndicator color={tint} />
          <Text style={[styles.stateBody, { color: muted }]}>{t('assistants.state.unavailable')}</Text>
        </RNView>
      </View>
    );
  }

  if (catalog.status === 'disabled') {
    return (
      <View style={styles.root}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}
          refreshControl={refreshControl}
        >
          <Text style={styles.title}>{title}</Text>
          <RNView style={[styles.guideCard, { backgroundColor: surface }]}>
            <Text style={styles.guideTitle}>{t('assistants.guide.disabledTitle')}</Text>
            <Text style={[styles.guideBody, { color: muted }]}>
              {t('assistants.guide.disabledDescription')}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={catalog.enabling}
              onPress={() => void catalog.enableAssistants()}
              style={[styles.primaryBtn, { backgroundColor: tint, opacity: catalog.enabling ? 0.7 : 1 }]}
            >
              {catalog.enabling ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryBtnLabel}>{t('assistants.guide.enableAction')}</Text>
              )}
            </Pressable>
            {catalog.error ? (
              <Text style={styles.errorText}>{catalog.error}</Text>
            ) : null}
            <Text style={[styles.shareTitle, { color: text }]}>{t('assistants.guide.shareTitle')}</Text>
            <Text style={[styles.guideBody, { color: muted }]}>
              {t('assistants.guide.share.pick.description')}
            </Text>
          </RNView>
        </ScrollView>
      </View>
    );
  }

  if (catalog.status === 'empty') {
    return (
      <View style={styles.root}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}
          refreshControl={refreshControl}
        >
          <Text style={styles.title}>{title}</Text>
          <RNView style={[styles.stateCard, { backgroundColor: surface }]}>
            <Text style={styles.guideTitle}>{t('assistants.onboarding.title')}</Text>
            <Text style={[styles.guideBody, { color: muted }]}>
              {t('assistants.onboarding.description')}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={handleCreate}
              style={[styles.primaryBtn, { backgroundColor: tint }]}
            >
              <Text style={styles.primaryBtnLabel}>{t('assistants.onboarding.action')}</Text>
            </Pressable>
          </RNView>
        </ScrollView>
      </View>
    );
  }

  if (catalog.status === 'unsupported' || catalog.status === 'unavailable' || catalog.status === 'error') {
    const heading =
      catalog.status === 'unsupported'
        ? t('assistants.state.unsupportedTitle')
        : t('assistants.state.unavailable');
    const detail =
      catalog.status === 'unsupported'
        ? t('assistants.state.unsupportedDescription')
        : catalog.error
          ? catalog.error
          : t('assistants.state.instanceDisabledDescription');
    return (
      <View style={styles.root}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}
          refreshControl={refreshControl}
        >
          <Text style={styles.title}>{title}</Text>
          <RNView style={[styles.stateCard, { backgroundColor: surface }]}>
            <Text style={styles.guideTitle}>{heading}</Text>
            <Text style={[styles.guideBody, { color: muted }]}>{detail}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void onRefresh()}
              style={[styles.secondaryBtn, { borderColor: muted }]}
            >
              <Text style={{ color: text }}>{t('mobile.sessions.index.retry')}</Text>
            </Pressable>
          </RNView>
        </ScrollView>
      </View>
    );
  }

  const deleteName = deleteTarget
    ? getAssistantPresentation(deleteTarget.name).displayName || deleteTarget.name
    : '';

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}
        refreshControl={refreshControl}
      >
        <Text style={styles.title}>{title}</Text>
        <RNView style={styles.list} accessibilityRole="list">
          {catalog.assistants.map((assistant) => (
            <AssistantCard
              key={assistant.id}
              assistant={assistant}
              dark={dark}
              muted={muted}
              surface={surface}
              opening={catalog.openingId === assistant.id}
              onOpen={() => void handleOpen(assistant)}
              onEdit={() => handleEdit(assistant)}
              onDelete={() => setDeleteTarget(assistant)}
            />
          ))}
        </RNView>
        {catalog.error ? <Text style={styles.errorText}>{catalog.error}</Text> : null}
      </ScrollView>

      <AssistantDeleteConfirm
        visible={deleteTarget !== null}
        name={deleteName}
        pending={deleting}
        dark={dark}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={() => void handleConfirmDelete()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  scroll: {
    paddingHorizontal: 16,
    gap: 14,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.4,
    marginBottom: 4,
  },
  list: {
    gap: 10,
  },
  stateCard: {
    borderRadius: 18,
    padding: 20,
    gap: 12,
    alignItems: 'flex-start',
  },
  guideCard: {
    borderRadius: 18,
    padding: 20,
    gap: 12,
  },
  guideTitle: {
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  guideBody: {
    fontSize: 14,
    lineHeight: 20,
  },
  shareTitle: {
    marginTop: 8,
    fontSize: 15,
    fontWeight: '600',
  },
  stateBody: {
    fontSize: 14,
  },
  primaryBtn: {
    marginTop: 8,
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    paddingHorizontal: 16,
  },
  primaryBtnLabel: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryBtn: {
    marginTop: 4,
    minHeight: 40,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    color: '#dc2626',
    fontSize: 13,
  },
});
