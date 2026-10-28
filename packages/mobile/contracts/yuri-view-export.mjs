/** Declarative bridge surface for YuriViewExport. */
export const yuriViewExportContract = {
  pluginName: 'YuriViewExport',
  platforms: ['ios', 'android'],
  sources: {
    ios: ['packages/mobile/ios/App/App/YuriViewExportPlugin.swift'],
    android: ['packages/mobile/android/app/src/main/java/com/yuri/app/YuriViewExportPlugin.java'],
  },
  methods: {
    ios: ['capabilities', 'exportPDF', 'exportLongImage', 'cancel'],
    android: ['capabilities', 'exportPDF', 'exportLongImage', 'cancel'],
  },
  events: {
    ios: ['progress'],
    android: ['progress'],
  },
}
