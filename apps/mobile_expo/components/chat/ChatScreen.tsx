import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Dimensions,
  Platform,
  Share,
  StyleSheet,
  View as RNView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChangesSheet } from '@/components/chat/ChangesSheet';
import { ChatDetailHeader } from '@/components/chat/ChatDetailHeader';
import { ChatComposer } from '@/components/chat/ChatComposer';
import { FilesSheet } from '@/components/chat/FilesSheet';
import { MobileSessionsSheet } from '@/components/chat/MobileSessionsSheet';
import { PermissionCard } from '@/components/chat/PermissionCard';
import { QuestionCard } from '@/components/chat/QuestionCard';
import { QueueEditModal } from '@/components/chat/QueueEditModal';
import { QueuedMessageChips } from '@/components/chat/QueuedMessageChips';
import {
  TranscriptList,
  type TranscriptListHandle,
} from '@/components/chat/TranscriptList';
import { Text, View, useThemeColor } from '@/components/Themed';
import { useChatSession } from '@/hooks/useChatSession';
import { useComposerAutocomplete } from '@/hooks/useComposerAutocomplete';
import { useConnection } from '@/context/ConnectionContext';
import { evaluateHeaderSwipe } from '@/lib/headerSwipe';
import type { MessageQueueChipItem } from '@/lib/messageQueueApi';
import { forkChatSession, shareChatSession } from '@/lib/sessionChatActions';
import {
  evaluateSwipeDirection,
  isNativeIosBackEdgeStart,
  rankSessionsForSwipe,
  resolveSessionSwipeNeighbor,
  shouldStartSessionSwipe,
} from '@/lib/sessionSwipe';
import { loadSessionIndexSnapshot } from '@/lib/sessionIndex';
import { buildSessionHomeModel, DRAFT_ROUTE_ID } from '@/lib/sessionHomeModel';
import { t } from '@/lib/i18n';

export type ChatScreenProps = {
  routeSessionId: string | undefined;
};

export function ChatScreen({ routeSessionId }: ChatScreenProps) {
  const insets = useSafeAreaInsets();
  const chat = useChatSession(routeSessionId);
  const { state } = useConnection();
  const router = useRouter();
  const muted = useThemeColor({}, 'muted');
  const autocomplete = useComposerAutocomplete(state.active, chat.directory);
  const [androidEditItem, setAndroidEditItem] = useState<MessageQueueChipItem | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [rankedIds, setRankedIds] = useState<string[]>([]);
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const [composerOccupancy, setComposerOccupancy] = useState(0);
  const transcriptRef = useRef<TranscriptListHandle | null>(null);
  const swipeStart = useRef<{ x: number; y: number; surface: boolean } | null>(null);
  const headerSwipeStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!state.active) return;
    let cancelled = false;
    void loadSessionIndexSnapshot(state.active)
      .then((snapshot) => {
        if (cancelled || !snapshot) return;
        const model = buildSessionHomeModel(snapshot);
        setRankedIds(
          rankSessionsForSwipe(
            model.catalog.map((row) => ({
              id: row.id,
              parentID: row.parentID,
              activityMs: row.activityMs,
            })),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setRankedIds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [state.active, chat.sessionId]);

  const moveQueued = useCallback(
    (item: MessageQueueChipItem, direction: -1 | 1) => {
      const ids = chat.queueItems.map((entry) => entry.queueItemID);
      const index = ids.indexOf(item.queueItemID);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= ids.length) return;
      const ordered = ids.slice();
      const [removed] = ordered.splice(index, 1);
      ordered.splice(next, 0, removed!);
      void chat.reorderQueued(ordered);
    },
    [chat],
  );

  const editQueued = useCallback(
    (item: MessageQueueChipItem) => {
      if (Platform.OS === 'ios') {
        Alert.prompt(
          t('mobile.chat.queue.editTitle'),
          t('mobile.chat.queue.editBody'),
          [
            { text: t('mobile.chat.attach.cancel'), style: 'cancel' },
            {
              text: t('mobile.chat.queue.editSave'),
              onPress: (value?: string) => {
                if (typeof value === 'string') void chat.editQueued(item, value);
              },
            },
          ],
          'plain-text',
          item.content,
        );
        return;
      }
      setAndroidEditItem(item);
    },
    [chat],
  );

  const runOverflow = useCallback(
    async (action: 'files' | 'changes' | 'share' | 'fork' | 'refresh' | 'copy') => {
      if (action === 'files') {
        setFilesOpen(true);
        return;
      }
      if (action === 'changes') {
        setChangesOpen(true);
        return;
      }
      if (action === 'refresh') {
        void chat.refresh();
        return;
      }
      if (!state.active || !chat.sessionId) return;
      try {
        if (action === 'share') {
          const shared = await shareChatSession(state.active, chat.sessionId, chat.directory);
          if (shared.shareUrl) {
            await Share.share({ message: shared.shareUrl });
          } else {
            Alert.alert(t('mobile.chat.menu.share'), 'OK');
          }
          return;
        }
        if (action === 'fork') {
          const forked = await forkChatSession(state.active, chat.sessionId, {
            directory: chat.directory,
          });
          router.replace(`/chat/${encodeURIComponent(forked.id)}`);
          return;
        }
        if (action === 'copy') {
          const text = chat.rows
            .map((row) => `${row.role}: ${row.text}`)
            .join('\n\n')
            .slice(0, 50_000);
          await Share.share({ message: text || chat.sessionId });
        }
      } catch (err) {
        Alert.alert('Error', err instanceof Error ? err.message : 'action failed');
      }
    },
    [chat, router, state.active],
  );

  const openOverflow = useCallback(() => {
    const labels = [
      t('mobile.chat.menu.files'),
      t('mobile.chat.menu.changes'),
      t('mobile.chat.menu.share'),
      t('mobile.chat.menu.fork'),
      t('mobile.chat.menu.refresh'),
      t('mobile.chat.menu.copy'),
      t('mobile.chat.attach.cancel'),
    ];
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: labels, cancelButtonIndex: labels.length - 1 },
        (index) => {
          const map = ['files', 'changes', 'share', 'fork', 'refresh', 'copy'] as const;
          if (index >= 0 && index < map.length) void runOverflow(map[index]!);
        },
      );
      return;
    }
    Alert.alert(t('mobile.chat.title'), undefined, [
      { text: labels[0], onPress: () => void runOverflow('files') },
      { text: labels[1], onPress: () => void runOverflow('changes') },
      { text: labels[2], onPress: () => void runOverflow('share') },
      { text: labels[3], onPress: () => void runOverflow('fork') },
      { text: labels[4], onPress: () => void runOverflow('refresh') },
      { text: labels[5], onPress: () => void runOverflow('copy') },
      { text: labels[6], style: 'cancel' },
    ]);
  }, [runOverflow]);


  const onComposerTouchStart = (x: number, y: number) => {
    const ok = shouldStartSessionSwipe({
      onExplicitSurface: true,
      onCodeBlock: false,
      withinHorizontalScroller: false,
      withinNativeBackEdge: isNativeIosBackEdgeStart(x, Platform.OS),
      composerActive: false,
    });
    swipeStart.current = ok ? { x, y, surface: true } : null;
  };

  const onComposerTouchEnd = (x: number, y: number) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start?.surface || !chat.sessionId) return;
    const direction = evaluateSwipeDirection({
      startX: start.x,
      startY: start.y,
      endX: x,
      endY: y,
    });
    if (!direction) return;
    const neighbor = resolveSessionSwipeNeighbor(rankedIds, chat.sessionId, direction);
    if (neighbor) router.replace(`/chat/${encodeURIComponent(neighbor)}`);
  };

  const onBodyTouchStart = (x: number, y: number) => {
    headerSwipeStart.current = { x, y };
  };

  const onBodyTouchEnd = (x: number, y: number) => {
    const start = headerSwipeStart.current;
    headerSwipeStart.current = null;
    if (!start) return;
    const result = evaluateHeaderSwipe({
      startX: start.x,
      startY: start.y,
      endX: x,
      endY: y,
      viewportWidth: Dimensions.get('window').width,
      disabled: filesOpen || changesOpen || sessionsOpen,
      startedOnExcludedTarget: false,
    });
    if (result.back) {
      router.back();
      return;
    }
    if (result.open) {
      setSessionsOpen(true);
    }
  };

  return (
    <View
      style={styles.root}
      onStartShouldSetResponder={() => true}
      onResponderGrant={(e) => onBodyTouchStart(e.nativeEvent.pageX, e.nativeEvent.pageY)}
      onResponderRelease={(e) => onBodyTouchEnd(e.nativeEvent.pageX, e.nativeEvent.pageY)}
    >
      <ChatDetailHeader
        title={
          chat.isDraft
            ? t('mobile.chat.draftTitle')
            : t('mobile.chat.title')
        }
        subtitle={chat.directory ? chat.directory.split('/').filter(Boolean).slice(-2).join(' · ') : null}
        contextDisplay={chat.contextDisplay}
        onBack={() => router.back()}
        onOverflow={openOverflow}
      />

      {chat.status === 'loading' && chat.rows.length === 0 ? (
        <RNView style={styles.center}>
          <ActivityIndicator />
          <Text style={[styles.hint, { color: muted }]}>{t('mobile.chat.loading')}</Text>
        </RNView>
      ) : (
        <TranscriptList
          ref={transcriptRef}
          rows={chat.rows}
          structureEpoch={chat.structureEpoch}
          emptyLabel={chat.isDraft ? t('mobile.chat.draftEmpty') : t('mobile.chat.empty')}
          onAwayFromEndChange={setAwayFromEnd}
          onMessageLongPress={(row) => {
            const options = [
              t('mobile.chat.message.copy'),
              t('mobile.chat.message.share'),
              t('mobile.chat.message.fork'),
              t('mobile.chat.attach.cancel'),
            ];
            const run = async (kind: 'copy' | 'share' | 'fork') => {
              try {
                if (kind === 'copy' || kind === 'share') {
                  await Share.share({ message: row.text || '' });
                  return;
                }
                if (!state.active || !chat.sessionId) return;
                const forked = await forkChatSession(state.active, chat.sessionId, {
                  messageId: row.id,
                  directory: chat.directory,
                });
                router.replace(`/chat/${encodeURIComponent(forked.id)}`);
              } catch (err) {
                Alert.alert('Error', err instanceof Error ? err.message : 'failed');
              }
            };
            if (Platform.OS === 'ios') {
              ActionSheetIOS.showActionSheetWithOptions(
                { options, cancelButtonIndex: 3 },
                (index) => {
                  if (index === 0) void run('copy');
                  if (index === 1) void run('share');
                  if (index === 2) void run('fork');
                },
              );
              return;
            }
            Alert.alert(t('mobile.chat.message.copy'), undefined, [
              { text: options[0], onPress: () => void run('copy') },
              { text: options[1], onPress: () => void run('share') },
              { text: options[2], onPress: () => void run('fork') },
              { text: options[3], style: 'cancel' },
            ]);
          }}
        />
      )}

      {chat.error ? (
        <RNView style={styles.errorBanner}>
          <Text style={styles.errorText}>{chat.error}</Text>
        </RNView>
      ) : null}

      {/* Accessories dock to collapsed occupancy only (Cap --oc-native-composer-height).
          Expand / autocomplete / scroll-to-bottom overlays must not raise this inset. */}
      <RNView
        pointerEvents="box-none"
        style={[
          styles.accessoryDock,
          {
            // published occupancy = collapsed pill; add shell safe-bottom (padTop cancels Cap -8 settle).
            bottom: Math.max(composerOccupancy, 48) + Math.max(insets.bottom, 8),
          },
        ]}
      >
        {chat.pendingQuestions.map((question) => (
          <QuestionCard
            key={question.id}
            question={question}
            busy={chat.questionBusyId === question.id}
            onSubmit={(answers) => chat.replyQuestion(question, answers)}
            onDismiss={() => chat.dismissQuestion(question)}
          />
        ))}

        {chat.pendingPermissions.map((perm) => (
          <PermissionCard
            key={perm.id}
            permission={perm}
            busy={chat.permissionBusyId === perm.id}
            onRespond={(response) => chat.respondPermission(perm, response)}
          />
        ))}

        <QueuedMessageChips
          items={chat.queueItems}
          onRemove={(item) => {
            void chat.removeQueued(item);
          }}
          onMoveUp={(item) => moveQueued(item, -1)}
          onMoveDown={(item) => moveQueued(item, 1)}
          onEdit={editQueued}
        />
      </RNView>

      <RNView
        onStartShouldSetResponder={() => true}
        onResponderGrant={(e) =>
          onComposerTouchStart(e.nativeEvent.pageX, e.nativeEvent.pageY)
        }
        onResponderRelease={(e) =>
          onComposerTouchEnd(e.nativeEvent.pageX, e.nativeEvent.pageY)
        }
      >
        <ChatComposer
          value={chat.draft}
          onChangeText={chat.setDraft}
          onSend={() => {
            void chat.send();
          }}
          onStop={() => {
            void chat.stop();
          }}
          busy={chat.busy}
          autocompleteRows={autocomplete.rows}
          autocompleteLoading={autocomplete.loading}
          onAutocompleteTriggerChange={autocomplete.onTriggerChange}
          attachments={chat.attachments}
          onAttachmentsChange={chat.setAttachments}
          showScrollToBottom={awayFromEnd}
          onScrollToBottom={() => transcriptRef.current?.scrollToEnd(true)}
          onOccupancyHeightChange={setComposerOccupancy}
        />
      </RNView>

      <QueueEditModal
        visible={androidEditItem != null}
        initialValue={androidEditItem?.content ?? ''}
        onCancel={() => setAndroidEditItem(null)}
        onSave={(value) => {
          const item = androidEditItem;
          setAndroidEditItem(null);
          if (item) void chat.editQueued(item, value);
        }}
      />

      <FilesSheet
        visible={filesOpen}
        rootDirectory={chat.directory}
        onClose={() => setFilesOpen(false)}
      />
      <ChangesSheet
        visible={changesOpen}
        directory={chat.directory}
        onClose={() => setChangesOpen(false)}
      />

      <MobileSessionsSheet
        visible={sessionsOpen}
        currentSessionId={chat.sessionId}
        onClose={() => setSessionsOpen(false)}
        onOpenSession={(sessionId) => {
          setSessionsOpen(false);
          router.replace(`/chat/${encodeURIComponent(sessionId)}`);
        }}
        onDraft={() => {
          setSessionsOpen(false);
          router.replace(`/chat/${DRAFT_ROUTE_ID}`);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  accessoryDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 4,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  hint: {
    fontSize: 14,
  },
  errorBanner: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(180,35,24,0.15)',
  },
  errorText: {
    color: '#F97066',
    fontSize: 13,
  },
});
