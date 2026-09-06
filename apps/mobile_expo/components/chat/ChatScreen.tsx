import React from 'react';
import { ActivityIndicator, StyleSheet, View as RNView } from 'react-native';

import { ChatComposer } from '@/components/chat/ChatComposer';
import { TranscriptList } from '@/components/chat/TranscriptList';
import { Text, View, useThemeColor } from '@/components/Themed';
import { useChatSession } from '@/hooks/useChatSession';
import { t } from '@/lib/i18n';

export type ChatScreenProps = {
  routeSessionId: string | undefined;
};

export function ChatScreen({ routeSessionId }: ChatScreenProps) {
  const chat = useChatSession(routeSessionId);
  const muted = useThemeColor({}, 'muted');

  return (
    <View style={styles.root}>
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
