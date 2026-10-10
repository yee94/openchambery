export const desktopOtaEvidenceArgs = ({ script, root, stage = 'download', platform = process.platform }) => {
  // Linux checks the sandbox before loading the fixture's JavaScript. Both
  // spawn and relaunch must supply this test-only switch on the native argv.
  return [script, root, stage, ...(platform === 'linux' ? ['--no-sandbox'] : [])];
};
