/** Declarative bridge surface for OpenChamberHaptics. Derived from plugin sources. */
export const openChamberHapticsContract = {
  pluginName: 'OpenChamberHaptics',
  platforms: ['ios', 'android'],
  sources: {
    ios: ['packages/mobile/ios/App/App/OpenChamberHapticsPlugin.swift'],
    android: [
      'packages/mobile/android/app/src/main/java/com/openchamber/app/OpenChamberHapticsPlugin.java',
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
