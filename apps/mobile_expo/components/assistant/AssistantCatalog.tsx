import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  StyleSheet,
  View as RNView,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AssistantCard } from '@/components/assistant/AssistantCard';
import { AssistantDeleteConfirm } from '@/components/assistant/AssistantDeleteConfirm';
import {
  MobileTabPageHeader,
  useCollapsingTabHeader,
} from '@/components/chrome/MobileTabPageHeader';
import { Text, View, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { useAssistantsCatalog } from '@/hooks/useAssistantsCatalog';
import { getAssistantPresentation } from '@/lib/assistantPresentation';
import type { AssistantDTO } from '@/lib/assistantsApi';
import { t } from '@/lib/i18n';

/** Cap --oc-mobile-surface-radius. */
const SURFACE_RADIUS = 24;

function openAssistantsSettings(router: ReturnType<typeof useRouter>, params?: Record<string, string>) {
  router.push({
    pathname: '/(tabs)/settings',
    params: { slug: 'assistants', ...params },
  });
}

function cardSurface(dark: boolean): string {
  return dark ? '#171717' : '#ffffff';
}

export function AssistantCatalog() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  const tint = Colors[scheme].tint;
  const text = useThemeColor({}, 'text');
  const muted = dark ? 'rgba(250,250,250,0.55)' : 'rgba(24,24,27,0.55)';
  const background = useThemeColor({}, 'background');
  const surface = cardSurface(dark);
  const catalog = useAssistantsCatalog();
  const [deleteTarget, setDeleteTarget] = useState<AssistantDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { scrollY, onScroll, listTopPad } = useCollapsingTabHeader();

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
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => void onRefresh()}
      tintColor={tint}
      progressViewOffset={listTopPad}
    />
  );

  const scrollBody = (children: React.ReactNode) => (
    <Animated.ScrollView
      onScroll={onScroll}
      scrollEventThrottle={16}
      contentContainerStyle={[
        styles.scroll,
        { paddingTop: listTopPad, paddingBottom: insets.bottom + 88 },
      ]}
      refreshControl={refreshControl}
    >
      {children}
    </Animated.ScrollView>
  );

  if (catalog.status === 'idle' || catalog.status === 'loading') {
    return (
      <View style={[styles.root, { backgroundColor: background }]}>
        <MobileTabPageHeader title={title} scrollY={scrollY} />
        <RNView style={[styles.stateCard, { backgroundColor: surface, marginTop: listTopPad, marginHorizontal: 16 }]}>
          <ActivityIndicator color={tint} />
          <Text style={[styles.stateBody, { color: muted }]}>{t('assistants.state.unavailable')}</Text>
        </RNView>
      </View>
    );
  }

  if (catalog.status === 'disabled') {
    return (
      <View style={[styles.root, { backgroundColor: background }]}>
        <MobileTabPageHeader title={title} scrollY={scrollY} />
        {scrollBody(
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
            {catalog.error ? <Text style={styles.errorText}>{catalog.error}</Text> : null}
            <Text style={[styles.shareTitle, { color: text }]}>{t('assistants.guide.shareTitle')}</Text>
            <Text style={[styles.guideBody, { color: muted }]}>
              {t('assistants.guide.share.pick.description')}
            </Text>
          </RNView>,
        )}
      </View>
    );
  }

  if (catalog.status === 'empty') {
    return (
      <View style={[styles.root, { backgroundColor: background }]}>
        <MobileTabPageHeader title={title} scrollY={scrollY} />
        {scrollBody(
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
          </RNView>,
        )}
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
      <View style={[styles.root, { backgroundColor: background }]}>
        <MobileTabPageHeader title={title} scrollY={scrollY} />
        {scrollBody(
          <RNView style={[styles.stateCard, { backgroundColor: surface }]}>
            <Text style={styles.guideTitle}>{heading}</Text>
            <Text style={[styles.guideBody, { color: muted }]}>{detail}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void onRefresh()}
              style={[styles.secondaryBtn, { borderColor: muted }]}
            >
              <Text style={{ color: tint, fontWeight: '600' }}>{t('mobile.sessions.index.retry')}</Text>
            </Pressable>
          </RNView>,
        )}
      </View>
    );
  }

  const deleteName = deleteTarget
    ? getAssistantPresentation(deleteTarget.name).displayName || deleteTarget.name
    : '';

  return (
    <View style={[styles.root, { backgroundColor: background }]}>
      <MobileTabPageHeader title={title} scrollY={scrollY} />
      {scrollBody(
        <>
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
        </>,
      )}

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
  scroll: {
    paddingHorizontal: 16,
    gap: 14,
  },
  list: {
    gap: 14,
  },
  stateCard: {
    borderRadius: SURFACE_RADIUS,
    padding: 20,
    gap: 12,
    alignItems: 'flex-start',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  guideCard: {
    borderRadius: SURFACE_RADIUS,
    padding: 20,
    gap: 12,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
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
    borderRadius: 14,
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
    borderRadius: 12,
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
