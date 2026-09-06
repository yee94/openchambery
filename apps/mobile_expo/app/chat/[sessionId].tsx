import { useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { isDraftSessionRouteId, resolveChatSessionId } from '@/lib/sessionHomeModel';
import { t } from '@/lib/i18n';

/**
 * Pushed Chat route. Dock stays underneath until chrome hides it.
 * Transcript / LegendList / Send-Stop land in Track 3 — body stays stub.
 * Draft new session uses route id `draft` (Cap: sessionId == '' until first send).
 */
export default function ChatScreen() {
  const { sessionId: routeId } = useLocalSearchParams<{ sessionId: string }>();
  const draft = isDraftSessionRouteId(routeId);
  const sessionId = resolveChatSessionId(routeId);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{draft ? t('mobile.chat.draftTitle') : t('mobile.chat.title')}</Text>
      <Text style={styles.body}>
        {draft
          ? t('mobile.chat.draftBody')
          : `${t('mobile.chat.stubBody')} ${sessionId}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    opacity: 0.75,
  },
});
