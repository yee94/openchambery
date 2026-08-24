/** Declarative bridge surface for OpenChamberShare. Derived from plugin sources. */
export const openChamberShareContract = {
  pluginName: 'OpenChamberShare',
  platforms: ['ios', 'android'],
  sources: {
    ios: ['packages/mobile/ios/App/App/OpenChamberSharePlugin.swift'],
    android: [
      'packages/mobile/android/app/src/main/java/com/openchamber/app/OpenChamberSharePlugin.java',
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
