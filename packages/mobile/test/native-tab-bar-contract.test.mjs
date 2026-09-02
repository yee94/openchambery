import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('native tab bar uses UITabBar liquid glass and keeps web as the fallback', async () => {
  const plugin = await source('ios/App/App/OpenChamberTabBarPlugin.swift');
  const view = await source('ios/App/App/OpenChamberTabBarView.swift');
  const contract = await source('contracts/openchamber-tab-bar.mjs');
  const bridge = await source('ios/App/App/OpenChamberBridgeViewController.swift');

  assert.match(contract, /OpenChamberTabBar/);
  assert.match(contract, /tabSelected/);
  assert.match(bridge, /OpenChamberTabBarPlugin\(\)/);
  assert.match(view, /supportsLiquidGlass/);
  assert.match(view, /let chromeController = OpenChamberTabBarChromeController\(\)/);
  assert.match(view, /class OpenChamberTabBarChromeController: UITabBarController/);
  assert.match(view, /UITabBarControllerDelegate/);
  assert.match(view, /overrideUserInterfaceStyle = style/);
  assert.match(view, /appearance == "light" \? \.light : \.dark/);
  assert.match(view, /unselectedItemTintColor = \.secondaryLabel/);
  assert.match(view, /isTranslucent = true/);
  assert.match(view, /point\(inside/);
  assert.match(view, /view\.isUserInteractionEnabled = false/);
  assert.match(view, /view\.alpha = 0/);
  assert.doesNotMatch(view, /UITabBarAppearance/);
  assert.doesNotMatch(view, /backgroundImage/);
  assert.doesNotMatch(view, /selectionIndicatorImage/);
  assert.doesNotMatch(view, /UIHoverStyle/);
  assert.doesNotMatch(view, /selectionGlass/);
  assert.doesNotMatch(view, /UIPanGestureRecognizer/);
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
  assert.match(plugin, /bar\.attachChrome\(to: hostVC\)/);
  assert.match(plugin, /bar\.topAnchor\.constraint\(equalTo: host\.topAnchor\)/);
  assert.match(view, /static let dockHeight: CGFloat = 49/);
  assert.match(view, /accentColor/);
  assert.match(view, /UIImage\(systemName: item\.symbol\)/);
  assert.match(plugin, /accentColor: call\.getString\("accentColor"\)/);
  assert.match(plugin, /\("calendar", "calendar"\)/);
  assert.doesNotMatch(plugin, /calendar\.fill/);
  assert.doesNotMatch(view, /UIButton\.Configuration/);
});

test('native tab bar switching stays on the overlay and does not own the React page stack', async () => {
  const plugin = await source('ios/App/App/OpenChamberTabBarPlugin.swift');
  const view = await source('ios/App/App/OpenChamberTabBarView.swift');
  assert.match(view, /tabBarView\(self, didSelectTab: id\)/);
  assert.match(plugin, /didSelectTab id: String/);
  assert.match(plugin, /notifyListeners\("tabSelected"/);
  assert.match(view, /placeholder|UIViewController\(\)/);
  assert.match(view, /view\.backgroundColor = \.clear/);
  assert.doesNotMatch(view, /setActiveTab|pushViewController/);
});
