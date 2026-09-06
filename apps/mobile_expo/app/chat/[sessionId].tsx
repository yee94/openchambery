import { Stack, useLocalSearchParams } from 'expo-router';

import { ChatScreen } from '@/components/chat/ChatScreen';
import { isDraftSessionRouteId } from '@/lib/sessionHomeModel';
import { t } from '@/lib/i18n';

/**
 * Pushed Chat route — LegendList transcript + Send/Stop (Track 3).
 * Draft uses route id `draft` (sessionId == '' until first send).
 */
export default function ChatRoute() {
  const { sessionId: routeId } = useLocalSearchParams<{ sessionId: string }>();
  const draft = isDraftSessionRouteId(routeId);

  return (
    <>
      <Stack.Screen
        options={{
          title: draft ? t('mobile.chat.draftTitle') : t('mobile.chat.title'),
          headerBackTitle: t('mobile.tabs.projects'),
        }}
      />
      <ChatScreen routeSessionId={typeof routeId === 'string' ? routeId : undefined} />
    </>
  );
}
