import { DarkTheme, Stack, ThemeProvider, useRouter, useSegments } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect } from 'react';
import 'react-native-reanimated';

import { SplashConnecting } from '@/components/connect/SplashConnecting';
import { ConnectionProvider, useConnection } from '@/context/ConnectionContext';
import { useDeepLinkNavigation } from '@/hooks/useDeepLinkNavigation';
import { usePushRegistration } from '@/hooks/usePushRegistration';
import { useShareInbox } from '@/hooks/useShareInbox';
import { t } from '@/lib/i18n';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      void SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return (
    <ConnectionProvider>
      <RootLayoutNav />
    </ConnectionProvider>
  );
}

function RootLayoutNav() {
  const { state } = useConnection();
  const segments = useSegments();
  const router = useRouter();

  const openSession = useCallback(
    (sessionId: string) => {
      router.push(`/chat/${encodeURIComponent(sessionId)}`);
    },
    [router],
  );

  useDeepLinkNavigation();
  usePushRegistration({
    enabled: state.phase === 'connected',
    onOpenSession: openSession,
  });
  useShareInbox({ enabled: state.phase === 'connected' });

  useEffect(() => {
    if (state.phase === 'booting' || state.phase === 'connecting') return;

    const root = segments[0];
    const onConnectFlow = root === 'connect' || root === 'qr-scan';

    if (state.phase === 'connected') {
      if (onConnectFlow) router.replace('/');
      return;
    }

    // onboarding / password — keep QR reachable, otherwise land on connect
    if (!onConnectFlow) {
      router.replace('/connect');
    }
  }, [state.phase, segments, router]);

  if (state.phase === 'booting' || state.phase === 'connecting') {
    return <SplashConnecting label={state.splashLabel} />;
  }

  return (
    <ThemeProvider value={DarkTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="chat/[sessionId]"
          options={{
            title: t('mobile.chat.title'),
            headerBackTitle: t('mobile.tabs.projects'),
          }}
        />
        <Stack.Screen
          name="connect"
          options={{
            headerShown: false,
            animation: 'fade',
          }}
        />
        <Stack.Screen
          name="qr-scan"
          options={{
            presentation: 'fullScreenModal',
            headerShown: false,
          }}
        />
      </Stack>
    </ThemeProvider>
  );
}
