/** Declarative bridge surface for YuriHaptics. Derived from plugin sources. */
export const yuriHapticsContract = {
  pluginName: 'YuriHaptics',
  platforms: ['ios', 'android'],
  sources: {
    ios: ['packages/mobile/ios/App/App/YuriHapticsPlugin.swift'],
    android: [
      'packages/mobile/android/app/src/main/java/com/yuri/app/YuriHapticsPlugin.java',
    ],
  },
  methods: {
    ios: ['impactLight', 'impactMedium', 'impactHeavy'],
    android: ['impactLight', 'impactMedium', 'impactHeavy'],
  },
  events: {
    ios: [],
    android: [],
  },
}
