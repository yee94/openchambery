/** Declarative bridge surface for OpenChamberMedia. Derived from plugin sources. */
export const openChamberMediaContract = {
  pluginName: 'OpenChamberMedia',
  platforms: ['ios', 'android'],
  sources: {
    ios: ['packages/mobile/ios/App/App/OpenChamberMediaPlugin.swift'],
    android: [
      'packages/mobile/android/app/src/main/java/com/openchamber/app/OpenChamberMediaPlugin.java',
    ],
  },
  methods: {
    ios: ['saveImage', 'saveFile', 'transcode'],
    android: ['transcode', 'saveImage', 'saveFile', 'pickMedia'],
  },
  events: {
    ios: [],
    android: [],
  },
}
