/** Declarative bridge surface for YuriMedia. Derived from plugin sources. */
export const yuriMediaContract = {
  pluginName: 'YuriMedia',
  platforms: ['ios', 'android'],
  sources: {
    ios: ['packages/mobile/ios/App/App/YuriMediaPlugin.swift'],
    android: [
      'packages/mobile/android/app/src/main/java/com/yuri/app/YuriMediaPlugin.java',
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
