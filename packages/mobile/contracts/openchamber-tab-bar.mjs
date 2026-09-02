/** Declarative bridge surface for OpenChamberTabBar (iOS-only liquid-glass dock). */
export const openChamberTabBarContract = {
  pluginName: 'OpenChamberTabBar',
  platforms: ['ios'],
  sources: {
    ios: [
      'packages/mobile/ios/App/App/OpenChamberTabBarPlugin.swift',
      'packages/mobile/ios/App/App/OpenChamberTabBarView.swift',
    ],
  },
  methods: {
    ios: ['present', 'update', 'hide', 'dismiss'],
  },
  events: {
    ios: ['tabSelected', 'heightChanged'],
  },
}
