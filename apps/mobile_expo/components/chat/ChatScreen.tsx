import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Platform, StyleSheet, View as RNView } from 'react-native';

import { ChatComposer } from '@/components/chat/ChatComposer';
import { ContextUsageRing } from '@/components/chat/ContextUsageRing';
import { QuestionCard } from '@/components/chat/QuestionCard';
import { QueueEditModal } from '@/components/chat/QueueEditModal';
import { QueuedMessageChips } from '@/components/chat/QueuedMessageChips';
import { TranscriptList } from '@/components/chat/TranscriptList';
import { Text, View, useThemeColor } from '@/components/Themed';
import { useChatSession } from '@/hooks/useChatSession';
import { useComposerAutocomplete } from '@/hooks/useComposerAutocomplete';
import { useConnection } from '@/context/ConnectionContext';
import type { MessageQueueChipItem } from '@/lib/messageQueueApi';
import { t } from '@/lib/i18n';

export type ChatScreenProps = {
  routeSessionId: string | undefined;
};

export function ChatScreen({ routeSessionId }: ChatScreenProps) {
  const chat = useChatSession(routeSessionId);
  const { state } = useConnection();
  const muted = useThemeColor({}, 'muted');
  const autocomplete = useComposerAutocomplete(state.active, chat.directory);
  const [androidEditItem, setAndroidEditItem] = useState<MessageQueueChipItem | null>(null);

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

  return (
    <View style={styles.root}>
      <ContextUsageRing display={chat.contextDisplay} />

      {chat.status === 'loading' && chat.rows.length === 0 ? (
        <RNView style={styles.center}>
          <ActivityIndicator />
          <Text style={[styles.hint, { color: muted }]}>{t('mobile.chat.loading')}</Text>
        </RNView>
      ) : (
        <TranscriptList
          rows={chat.rows}
          structureEpoch={chat.structureEpoch}
          emptyLabel={
            chat.isDraft ? t('mobile.chat.draftEmpty') : t('mobile.chat.empty')
          }
        />
      )}

      {chat.error ? (
        <RNView style={styles.errorBanner}>
          <Text style={styles.errorText}>{chat.error}</Text>
        </RNView>
      ) : null}

      {chat.pendingQuestions.map((question) => (
        <QuestionCard
          key={question.id}
          question={question}
          busy={chat.questionBusyId === question.id}
          onSubmit={(answers) => chat.replyQuestion(question, answers)}
          onDismiss={() => chat.dismissQuestion(question)}
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
      />

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
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
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
