/** Declarative bridge surface for YuriExternalBrowser (Android-only). */
export const yuriExternalBrowserContract = {
  pluginName: 'YuriExternalBrowser',
  platforms: ['android'],
  sources: {
    android: [
      'packages/mobile/android/app/src/main/java/com/yuri/app/YuriExternalBrowserPlugin.java',
    ],
  },
  methods: {
    android: ['open'],
  },
  events: {
    android: [],
  },
}
