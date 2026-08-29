/** Declarative bridge surface for OpenChamberComposer (iOS-only). */
export const openChamberComposerContract = {
  pluginName: 'OpenChamberComposer',
  platforms: ['ios'],
  sources: {
    ios: [
      'packages/mobile/ios/App/App/OpenChamberComposerPlugin.swift',
    ],
  },
  methods: {
    ios: ['present', 'update', 'dismiss', 'setSuppressed', 'focus', 'blur'],
  },
  events: {
    ios: ['textChanged', 'send', 'abort', 'attach', 'openModel', 'heightChanged', 'expandedChanged'],
  },
}
