/**
 * Declarative bridge surface for YuriNavigation.
 * iOS lives in YuriBridgeViewController.swift (YuriNavigationPlugin class).
 */
export const yuriNavigationContract = {
  pluginName: 'YuriNavigation',
  platforms: ['ios', 'android'],
  sources: {
    ios: ['packages/mobile/ios/App/App/YuriBridgeViewController.swift'],
    android: [
      'packages/mobile/android/app/src/main/java/com/yuri/app/YuriNavigationPlugin.java',
    ],
  },
  methods: {
    ios: ['setEnabled'],
    android: ['setEnabled'],
  },
  events: {
    ios: ['backStarted', 'backProgressed', 'backInvoked', 'backCancelled'],
    android: ['backStarted', 'backProgressed', 'backCancelled', 'backInvoked'],
  },
}
