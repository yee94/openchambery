import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Platform } from 'react-native';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { t } from '@/lib/i18n';
import { impactLight } from '@/lib/systemShell/haptics';

/**
 * Four dock roots only. Chat is a pushed stack route (chat session pushed route), not a tab.
 *
 * iOS: expo-router NativeTabs → real UITabBar (iOS 26 liquid glass when OS paints it).
 * Android: Material bottom navigation — honest degrade, not fake iOS glass.
 * No openchamber.iosNativeUi toggle; native chrome is always on.
 *
 * Selected glyph/label = theme --primary (orange/sand); unselected = secondary.
 * Icon optical size is system (~23pt under UITabBar); selected wash is system full-slot.
 */
export default function TabLayout() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const isAndroid = Platform.OS === 'android';

  return (
    <NativeTabs
      tintColor={colors.tint}
      iconColor={{
        default: colors.tabIconDefault,
        selected: colors.tint,
      }}
      labelStyle={{
        default: {
          fontSize: 11,
          fontWeight: '600',
          color: colors.tabIconDefault,
        },
        selected: {
          fontSize: 11,
          fontWeight: '600',
          color: colors.tint,
        },
      }}
      blurEffect={isAndroid ? undefined : 'systemDefault'}
      backgroundColor={isAndroid ? (colorScheme === 'dark' ? '#18181b' : '#ffffff') : undefined}
      disableTransparentOnScrollEdge={isAndroid}
      labelVisibilityMode={isAndroid ? 'labeled' : undefined}
      minimizeBehavior="never"
    >
      <NativeTabs.Trigger
        name="index"
        accessibilityLabel={t('mobile.tabs.projects')}
        listeners={{
          tabPress: () => {
            void impactLight();
          },
        }}
      >
        <NativeTabs.Trigger.Label>{t('mobile.tabs.projects')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'folder', selected: 'folder.fill' }}
          md="folder"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger
        name="assistant"
        accessibilityLabel={t('mobile.tabs.assistant')}
        listeners={{
          tabPress: () => {
            void impactLight();
          },
        }}
      >
        <NativeTabs.Trigger.Label>{t('mobile.tabs.assistant')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="sparkles" md="auto_awesome" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger
        name="scheduled"
        accessibilityLabel={t('mobile.tabs.scheduled')}
        listeners={{
          tabPress: () => {
            void impactLight();
          },
        }}
      >
        <NativeTabs.Trigger.Label>{t('mobile.tabs.scheduled')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="calendar" md="calendar_month" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger
        name="settings"
        accessibilityLabel={t('mobile.tabs.settings')}
        listeners={{
          tabPress: () => {
            void impactLight();
          },
        }}
      >
        <NativeTabs.Trigger.Label>{t('mobile.tabs.settings')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'gearshape', selected: 'gearshape.fill' }}
          md="settings"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
