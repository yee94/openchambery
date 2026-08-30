import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('native tab bar adopts interactive liquid glass and keeps web as the fallback', async () => {
  const plugin = await source('ios/App/App/OpenChamberTabBarPlugin.swift');
  const view = await source('ios/App/App/OpenChamberTabBarView.swift');
  const contract = await source('contracts/openchamber-tab-bar.mjs');
  const bridge = await source('ios/App/App/OpenChamberBridgeViewController.swift');

  assert.match(contract, /OpenChamberTabBar/);
  assert.match(contract, /tabSelected/);
  assert.match(bridge, /OpenChamberTabBarPlugin\(\)/);
  assert.match(view, /supportsLiquidGlass/);
  assert.match(view, /UIGlassEffect\(style: \.regular\)/);
  assert.match(view, /glass\.isInteractive = true/);
  assert.match(view, /var contentView: UIView \{ blurView\.contentView \}/);
  assert.match(view, /UIHoverStyle\(effect: \.lift/);
  assert.match(view, /UIHoverStyle\(effect: \.highlight/);
  assert.match(plugin, /call\.resolve\(\["adopted": false\]\)/);
  assert.match(plugin, /call\.resolve\(\["adopted": true\]\)/);
  assert.match(plugin, /insertSubview\(bar, aboveSubview: webView\)/);
  assert.doesNotMatch(plugin, /removeFromSuperview/);
  assert.match(plugin, /tabBarView\?\.isHidden = true/);
  assert.match(plugin, /notifyListeners\("tabSelected"/);
  assert.match(plugin, /allowedIds/);
  assert.match(plugin, /"projects"/);
  assert.match(plugin, /"assistant"/);
  assert.match(plugin, /"scheduled"/);
  assert.match(plugin, /"settings"/);
  assert.match(plugin, /max\(OpenChamberTabBarView\.restFloor, safeBottom\)/);
  assert.match(view, /static let dockHeight: CGFloat = 68/);
  assert.match(view, /static let restFloor: CGFloat = 20/);
  assert.doesNotMatch(view, /UIButton\.Configuration/);
});

test('native tab bar switching stays on the overlay and does not own the React page stack', async () => {
  const plugin = await source('ios/App/App/OpenChamberTabBarPlugin.swift');
  const view = await source('ios/App/App/OpenChamberTabBarView.swift');
  assert.match(view, /tabBarView\(self, didSelectTab: id\)/);
  assert.match(plugin, /didSelectTab id: String/);
  assert.doesNotMatch(plugin, /UITabBarController/);
  assert.doesNotMatch(view, /UITabBarController/);
});
