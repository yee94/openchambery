/** Declarative bridge surface for YuriComposer (iOS-only). */
export const yuriComposerContract = {
  pluginName: 'YuriComposer',
  platforms: ['ios'],
  sources: {
    ios: [
      'packages/mobile/ios/App/App/YuriComposerPlugin.swift',
      'packages/mobile/ios/App/App/YuriComposerView.swift',
      'packages/mobile/ios/App/App/YuriComposerAutocomplete.swift',
    ],
  },
  methods: {
    ios: ['present', 'update', 'hide', 'show', 'dismiss', 'setSuppressed', 'focus', 'blur'],
  },
  events: {
    ios: ['textChanged', 'send', 'abort', 'attach', 'filesPicked', 'removeAttachment', 'openModel', 'cycleAgent', 'openAgent', 'heightChanged', 'expandedChanged', 'scrollToBottom', 'autocompleteAccept', 'autocompleteDismiss'],
  },
}
