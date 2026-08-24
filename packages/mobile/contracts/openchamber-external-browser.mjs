/** Declarative bridge surface for OpenChamberExternalBrowser (Android-only). */
export const openChamberExternalBrowserContract = {
  pluginName: 'OpenChamberExternalBrowser',
  platforms: ['android'],
  sources: {
    android: [
      'packages/mobile/android/app/src/main/java/com/openchamber/app/OpenChamberExternalBrowserPlugin.java',
    ],
  },
  methods: {
    android: ['open'],
  },
  events: {
    android: [],
  },
}
