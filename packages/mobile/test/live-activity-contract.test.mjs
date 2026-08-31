import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

function sourcesSection(pbx, phaseId) {
  const match = pbx.match(
    new RegExp(`${phaseId} /\\* Sources \\*/ = \\{[\\s\\S]*?files = \\(([\\s\\S]*?)\\);`),
  );
  assert.ok(match, `missing PBXSourcesBuildPhase ${phaseId}`);
  return match[1];
}

/** Mirrors OpenChamberLiveActivityManager.shouldApply(eventVersion:onto:). */
function shouldApply(eventVersion, current) {
  return eventVersion > current;
}

test('main Info.plist enables Live Activities', async () => {
  const info = await source('ios/App/App/Info.plist');
  assert.match(info, /<key>NSSupportsLiveActivities<\/key>\s*<true\/>/);
});

test('OpenChamberLiveActivity plugin is registered with the Capacitor bridge', async () => {
  const [bridge, plugin] = await Promise.all([
    source('ios/App/App/OpenChamberBridgeViewController.swift'),
    source('ios/App/App/OpenChamberLiveActivityPlugin.swift'),
  ]);

  assert.match(bridge, /registerPluginInstance\(OpenChamberLiveActivityPlugin\(\)\)/);
  assert.match(plugin, /jsName = "OpenChamberLiveActivity"/);
  assert.match(plugin, /CAPPluginMethod\(name: "isSupported"/);
  assert.match(plugin, /CAPPluginMethod\(name: "start"/);
  assert.match(plugin, /CAPPluginMethod\(name: "update"/);
  assert.match(plugin, /CAPPluginMethod\(name: "end"/);
  assert.match(plugin, /@objc func isSupported\(_ call: CAPPluginCall\)/);
  assert.match(plugin, /@objc func start\(_ call: CAPPluginCall\)/);
  assert.match(plugin, /@objc func update\(_ call: CAPPluginCall\)/);
  assert.match(plugin, /@objc func end\(_ call: CAPPluginCall\)/);
  assert.match(plugin, /call\.resolve\(\["supported": OpenChamberLiveActivityManager\.isSupported\(\)\]\)/);
  assert.match(plugin, /call\.resolve\(\["activityId": activityId\]\)/);
  assert.match(plugin, /call\.resolve\(\[:\]\)/);
  assert.match(plugin, /call\.reject\(error\.localizedDescription\)/);
  assert.match(plugin, /runtime-gated at iOS 17\.0/);
});

test('pbxproj target membership keeps shared attributes and isolates visual/lifecycle sources', async () => {
  const pbx = await source('ios/App/App.xcodeproj/project.pbxproj');
  const appSources = sourcesSection(pbx, '504EC3001FED79650016851F');
  const widgetSources = sourcesSection(pbx, 'D0A3000000000000000000C1');

  assert.match(appSources, /OpenChamberActivityAttributes\.swift in Sources/);
  assert.match(appSources, /OpenChamberLiveActivityManager\.swift in Sources/);
  assert.match(appSources, /OpenChamberLiveActivityPlugin\.swift in Sources/);
  assert.doesNotMatch(appSources, /OpenChamberLiveActivity\.swift in Sources/);

  assert.match(widgetSources, /OpenChamberActivityAttributes\.swift in Sources/);
  assert.match(widgetSources, /OpenChamberLiveActivity\.swift in Sources/);
  assert.doesNotMatch(widgetSources, /OpenChamberLiveActivityManager\.swift in Sources/);
  assert.doesNotMatch(widgetSources, /OpenChamberLiveActivityPlugin\.swift in Sources/);

  const sharedInApp = [...appSources.matchAll(/OpenChamberActivityAttributes\.swift in Sources/g)];
  const sharedInWidget = [...widgetSources.matchAll(/OpenChamberActivityAttributes\.swift in Sources/g)];
  assert.equal(sharedInApp.length, 1);
  assert.equal(sharedInWidget.length, 1);

  assert.match(pbx, /path = OpenChamberActivityAttributes\.swift/);
  assert.match(pbx, /path = OpenChamberLiveActivityManager\.swift/);
  assert.match(pbx, /path = OpenChamberLiveActivityPlugin\.swift/);
  assert.match(pbx, /path = OpenChamberLiveActivity\.swift/);
  assert.match(pbx, /INFOPLIST_FILE = OpenChamberWidget\/Info\.plist;\s*IPHONEOS_DEPLOYMENT_TARGET = 17\.0;/);
  assert.match(pbx, /INFOPLIST_FILE = App\/Info\.plist;[\s\S]*?IPHONEOS_DEPLOYMENT_TARGET = 15\.5;/);
});

test('plugin availability is iOS 17.0 while the App target stays 15.5', async () => {
  const [attributes, manager, plugin] = await Promise.all([
    source('ios/App/OpenChamberWidget/OpenChamberActivityAttributes.swift'),
    source('ios/App/App/OpenChamberLiveActivityManager.swift'),
    source('ios/App/App/OpenChamberLiveActivityPlugin.swift'),
  ]);

  assert.match(attributes, /@available\(iOS 17\.0, \*\)/);
  assert.match(manager, /@available\(iOS 17\.0, \*\)/);
  assert.match(manager, /if #available\(iOS 17\.0, \*\)/);
  assert.match(plugin, /iOS 17\.0/);
  assert.doesNotMatch(attributes, /@available\(iOS 16/);
  assert.doesNotMatch(manager, /@available\(iOS 16/);
  assert.doesNotMatch(manager, /#available\(iOS 16/);
  assert.match(manager, /canImport\(ActivityKit\)/);
  assert.match(attributes, /canImport\(ActivityKit\)/);
});

test('shared attributes and manager encode the local ActivityKit lifecycle contract', async () => {
  const [attributes, manager, plugin] = await Promise.all([
    source('ios/App/OpenChamberWidget/OpenChamberActivityAttributes.swift'),
    source('ios/App/App/OpenChamberLiveActivityManager.swift'),
    source('ios/App/App/OpenChamberLiveActivityPlugin.swift'),
  ]);

  assert.match(attributes, /struct OpenChamberActivityAttributes: ActivityAttributes/);
  assert.match(attributes, /var sessionID: String/);
  assert.match(attributes, /var startedAt: Double/);
  assert.match(attributes, /var status: String/);
  assert.match(attributes, /var eventVersion: Int/);
  assert.match(attributes, /var updatedAt: Double/);
  assert.match(attributes, /var endedAt: Double\?/);

  assert.match(manager, /ActivityAuthorizationInfo\(\)\.areActivitiesEnabled/);
  assert.match(manager, /Activity<OpenChamberActivityAttributes>\.activities/);
  assert.match(manager, /shouldApply\(eventVersion: request\.eventVersion, onto:/);
  assert.match(manager, /pushType: nil/);
  assert.match(manager, /staleInterval: TimeInterval = 20 \* 60/);
  assert.match(manager, /successDismissal: TimeInterval = 15 \* 60/);
  assert.match(manager, /errorDismissal: TimeInterval = 60 \* 60/);
  assert.match(manager, /request\.updatedAt \+ staleInterval/);
  assert.match(manager, /await existing\.end\(makeContent\(request\), dismissalPolicy:/);
  assert.match(manager, /switch activity\.activityState/);
  assert.match(manager, /case \.active, \.stale:/);
  assert.match(manager, /case \.ended, \.dismissed:/);
  assert.match(manager, /if let existing = reusable\.first/);
  assert.match(manager, /request\.status == "error"/);
  assert.match(manager, /"working", "tool", "retry", "input", "permission", "stale", "complete", "error"/);
  assert.match(manager, /requireOSSupport\(\)/);
  assert.match(manager, /throw OpenChamberLiveActivityError\.unsupported/);
  assert.match(manager, /dismissedSessionIDs/);
  assert.match(manager, /markDismissed/);
  assert.match(manager, /return nil/);

  assert.match(plugin, /"sessionId"/);
  assert.match(plugin, /"startedAt"/);
  assert.match(plugin, /"dismissalSeconds"/);
  assert.match(plugin, /Prefer Double so millisecond eventVersion/);
});

test('millisecond eventVersion immediately supersedes a recovered small counter', () => {
  assert.equal(shouldApply(1_700_000_000_000, 1), true);
  assert.equal(shouldApply(1_700_000_000_000, 7), true);
  assert.equal(shouldApply(8, 7), true);
  assert.equal(shouldApply(7, 7), false);
  assert.equal(shouldApply(6, 7), false);
});

test('docs describe the local Live Activity MVP and user-dismiss semantics', async () => {
  const [readme, handoff] = await Promise.all([
    source('README.md'),
    source('HANDOFF.md'),
  ]);

  for (const content of [readme, handoff]) {
    assert.match(content, /iOS 17\.0/);
    assert.match(content, /15\.5/);
    assert.match(content, /12 seconds/);
    assert.match(content, /pushType/);
    assert.match(content, /staleDate/);
    assert.match(content, /20 min/);
    assert.match(content, /15 min/);
    assert.match(content, /60 min/);
    assert.match(content, /Remote update/);
    assert.match(content, /same task/);
    assert.match(content, /millisecond/);
  }

  assert.match(readme, /currently selected top-level session/);
  assert.match(readme, /does not recreate it for that same task/);
  assert.match(readme, /reject as unsupported instead of succeeding silently/);
  assert.match(handoff, /User-dismissed Activities are not rebuilt for the same task/);
});

test('live activity sources keep OpenChamber branding and never log session or token values', async () => {
  const files = await Promise.all([
    source('ios/App/OpenChamberWidget/OpenChamberActivityAttributes.swift'),
    source('ios/App/App/OpenChamberLiveActivityManager.swift'),
    source('ios/App/App/OpenChamberLiveActivityPlugin.swift'),
    source('ios/App/OpenChamberWidget/OpenChamberLiveActivity.swift'),
  ]);

  for (const content of files) {
    assert.doesNotMatch(content, /print\(|NSLog\(|Logger\(/);
    assert.doesNotMatch(content, /pushToken|bearerToken/);
    assert.doesNotMatch(content, /OpenCode/);
    assert.doesNotMatch(content, /reject\([^\n]*\\\(sessionId/);
    assert.doesNotMatch(content, /errorDescription[^\n]*\\\(sessionId/);
  }

  const [attributes, manager, plugin, visual] = files;
  assert.match(attributes, /OpenChamberActivityAttributes/);
  assert.match(manager, /OpenChamberLiveActivityManager/);
  assert.match(plugin, /jsName = "OpenChamberLiveActivity"/);
  assert.match(visual, /struct OpenChamberLiveActivity: Widget/);
  assert.match(visual, /ActivityConfiguration\(for: OpenChamberActivityAttributes\.self\)/);
  assert.match(visual, /accessibilityLabel\(Text\("Open session"\)\)/);
  assert.doesNotMatch(visual, /configurationDisplayName\("OpenCode"\)/);
});
