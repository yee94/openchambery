/** Declarative bridge surface for YuriShare. Derived from plugin sources. */
export const yuriShareContract = {
  pluginName: 'YuriShare',
  platforms: ['ios', 'android'],
  sources: {
    ios: ['packages/mobile/ios/App/App/YuriSharePlugin.swift'],
    android: [
      'packages/mobile/android/app/src/main/java/com/yuri/app/YuriSharePlugin.java',
    ],
  },
  methods: {
    ios: [
      'updateCatalog',
      'donateAssistantInteraction',
      'listPending',
      'ack',
      'releaseFiles',
    ],
    android: [
      'updateCatalog',
      'listPending',
      'listDrafts',
      'pendingAssistantOpen',
      'ackAssistantOpen',
      'ack',
      'releaseFiles',
      'cancelDraft',
    ],
  },
  events: {
    ios: ['shareReceived'],
    android: ['shareReceived', 'shareDraftReceived', 'assistantOpenRequested'],
  },
}
