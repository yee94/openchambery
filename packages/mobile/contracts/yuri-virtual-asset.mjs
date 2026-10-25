/** Declarative bridge surface for YuriVirtualAsset. Derived from plugin sources. */
export const yuriVirtualAssetContract = {
  pluginName: 'YuriVirtualAsset',
  platforms: ['ios', 'android'],
  sources: {
    ios: ['packages/mobile/ios/App/App/YuriVirtualAssetPlugin.swift'],
    android: [
      'packages/mobile/android/app/src/main/java/com/yuri/app/YuriVirtualAssetPlugin.java',
    ],
  },
  methods: {
    ios: ['create', 'append', 'finish', 'cancel'],
    android: ['create', 'append', 'finish', 'cancel'],
  },
  events: {
    ios: [],
    android: [],
  },
}
