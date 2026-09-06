import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';

import { parseDeepLink } from '@/lib/systemShell/deepLinks';

/**
 * Handles openchamber://session/{id} (push / Live Activity / share cold start).
 */
export function useDeepLinkNavigation(): void {
  const router = useRouter();

  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url) return;
      const intent = parseDeepLink(url);
      if (!intent) return;
      if (intent.type === 'session') {
        router.push(`/chat/${encodeURIComponent(intent.sessionId)}`);
        return;
      }
      if (intent.type === 'settings') {
        router.push('/settings');
        return;
      }
      if (intent.type === 'connect') {
        router.push('/connect');
      }
    };

    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', (event) => handle(event.url));
    return () => sub.remove();
  }, [router]);
}
