/**
 * Declarative bridge surface for OpenChamberNavigation.
 * iOS lives in OpenChamberBridgeViewController.swift (OpenChamberNavigationPlugin class).
 */
export const openChamberNavigationContract = {
  pluginName: 'OpenChamberNavigation',
  platforms: ['ios', 'android'],
  sources: {
    ios: ['packages/mobile/ios/App/App/OpenChamberBridgeViewController.swift'],
    android: [
      'packages/mobile/android/app/src/main/java/com/openchamber/app/OpenChamberNavigationPlugin.java',
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
