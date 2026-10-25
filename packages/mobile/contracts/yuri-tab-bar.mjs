/** Declarative bridge surface for YuriTabBar (iOS-only liquid-glass dock). */
export const yuriTabBarContract = {
  pluginName: 'YuriTabBar',
  platforms: ['ios'],
  sources: {
    ios: [
      'packages/mobile/ios/App/App/YuriTabBarPlugin.swift',
      'packages/mobile/ios/App/App/YuriTabBarView.swift',
    ],
  },
  methods: {
    ios: ['present', 'update', 'hide', 'dismiss'],
  },
  events: {
    ios: ['tabSelected', 'heightChanged'],
  },
}
