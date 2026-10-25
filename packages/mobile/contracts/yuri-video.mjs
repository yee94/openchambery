/** iOS HTTP range adapter; renderer retains remote paths and credentials. */
export const yuriVideoContract = {
  pluginName: 'YuriVideo',
  platforms: ['ios'],
  sources: { ios: ['packages/mobile/ios/App/App/YuriVideoPlugin.swift', 'packages/mobile/ios/App/App/YuriVideoServer.swift'] },
  methods: { ios: ['create', 'respond', 'release'] },
  events: { ios: ['request'] },
};
