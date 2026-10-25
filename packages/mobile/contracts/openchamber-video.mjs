/** iOS HTTP range adapter; renderer retains remote paths and credentials. */
export const openChamberVideoContract = {
  pluginName: 'OpenChamberVideo',
  platforms: ['ios'],
  sources: { ios: ['packages/mobile/ios/App/App/OpenChamberVideoPlugin.swift', 'packages/mobile/ios/App/App/OpenChamberVideoServer.swift'] },
  methods: { ios: ['create', 'respond', 'release'] },
  events: { ios: ['request'] },
};
