/** Declarative bridge surface for OpenChamberComposer (iOS-only). */
export const openChamberComposerContract = {
  pluginName: 'OpenChamberComposer',
  platforms: ['ios'],
  sources: {
    ios: [
      'packages/mobile/ios/App/App/OpenChamberComposerPlugin.swift',
      'packages/mobile/ios/App/App/OpenChamberComposerView.swift',
      'packages/mobile/ios/App/App/OpenChamberComposerAutocomplete.swift',
    ],
  },
  methods: {
    ios: ['present', 'update', 'hide', 'show', 'dismiss', 'setSuppressed', 'focus', 'blur'],
  },
  events: {
    ios: ['textChanged', 'send', 'abort', 'attach', 'filesPicked', 'removeAttachment', 'openModel', 'cycleAgent', 'openAgent', 'heightChanged', 'expandedChanged', 'scrollToBottom', 'autocompleteAccept', 'autocompleteDismiss'],
  },
}
