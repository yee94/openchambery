/** Declarative bridge surface for OpenChamberVirtualAsset. Derived from plugin sources. */
export const openChamberVirtualAssetContract = {
  pluginName: 'OpenChamberVirtualAsset',
  platforms: ['ios', 'android'],
  sources: {
    ios: ['packages/mobile/ios/App/App/OpenChamberVirtualAssetPlugin.swift'],
    android: [
      'packages/mobile/android/app/src/main/java/com/openchamber/app/OpenChamberVirtualAssetPlugin.java',
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
