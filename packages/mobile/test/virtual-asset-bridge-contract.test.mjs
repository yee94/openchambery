import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('virtual asset TS plugin exposes create/append/finish/cancel and opaque scheme URL', async () => {
  const ts = await source('src/openchamber-virtual-asset.ts');
  assert.match(ts, /registerPlugin<OpenChamberVirtualAssetPlugin>\(\s*'OpenChamberVirtualAsset'/);
  assert.match(ts, /create\(options: VirtualAssetCreateOptions\)/);
  assert.match(ts, /append\(options: VirtualAssetAppendOptions\)/);
  assert.match(ts, /finish\(options: VirtualAssetIdOptions\)/);
  assert.match(ts, /cancel\(options: VirtualAssetIdOptions\)/);
  assert.match(ts, /VIRTUAL_ASSET_SCHEME = 'openchamber-asset'/);
  assert.match(ts, /openchamber-asset:\/\/v\//);
  assert.match(ts, /export function normalizeVirtualAssetMime/);
  assert.match(ts, /image\/\*[\s`]*strict subtype/);
  assert.match(ts, /X-Content-Type-Options: nosniff/);
  assert.match(ts, /One reader per asset/);
  assert.doesNotMatch(ts, /password|bearerToken|hostPath|filePath|Authorization/i);
});

test('iOS registers WKURLSchemeHandler and progressive didReceive delivery', async () => {
  const [bridge, handler, store, plugin, pbx] = await Promise.all([
    source('ios/App/App/OpenChamberBridgeViewController.swift'),
    source('ios/App/App/OpenChamberVirtualAssetHandler.swift'),
    source('ios/App/App/OpenChamberVirtualAssetStore.swift'),
    source('ios/App/App/OpenChamberVirtualAssetPlugin.swift'),
    source('ios/App/App.xcodeproj/project.pbxproj'),
  ]);

  assert.match(bridge, /setURLSchemeHandler\(virtualAssetHandler, forURLScheme: OpenChamberVirtualAssetStore\.scheme\)/);
  assert.match(bridge, /registerPluginInstance\(OpenChamberVirtualAssetPlugin\(\)\)/);
  assert.match(handler, /WKURLSchemeHandler/);
  assert.match(handler, /urlSchemeTask\.didReceive\(response\)/);
  assert.match(handler, /urlSchemeTask\.didReceive\(chunk\)/);
  assert.match(store, /static let scheme = "openchamber-asset"/);
  assert.match(store, /static let ttlSeconds: TimeInterval = 120/);
  assert.match(store, /static let maxConcurrentAssets = 16/);
  assert.match(store, /static let maxAssetBytes = 32 \* 1024 \* 1024/);
  assert.match(store, /static let maxQueuedBytes = 4 \* 1024 \* 1024/);
  assert.match(store, /func normalizeImageMime\(_ mime: String\) -> String\?/);
  assert.match(store, /normalized\.contains\("\\n"\) \|\| normalized\.contains\("\\r"\) \|\| normalized\.contains\("\\0"\)/);
  assert.match(store, /hasPrefix\("image\/"\)/);
  assert.match(store, /if !asset\.readers\.isEmpty \{ return nil \}/);
  assert.match(store, /func append\(assetId: String, base64 chunk: String\)/);
  assert.match(store, /func cancel\(assetId: String\)/);
  assert.match(handler, /"X-Content-Type-Options": "nosniff"/);
  assert.match(plugin, /jsName = "OpenChamberVirtualAsset"/);
  assert.match(plugin, /CAPPluginMethod\(name: "create"/);
  assert.match(plugin, /CAPPluginMethod\(name: "append"/);
  assert.match(plugin, /CAPPluginMethod\(name: "finish"/);
  assert.match(plugin, /CAPPluginMethod\(name: "cancel"/);
  assert.match(pbx, /OpenChamberVirtualAssetStore\.swift in Sources/);
  assert.match(pbx, /OpenChamberVirtualAssetHandler\.swift in Sources/);
  assert.match(pbx, /OpenChamberVirtualAssetPlugin\.swift in Sources/);
  for (const content of [store, handler, plugin]) {
    assert.doesNotMatch(content, /relay.*token|bearerToken|hostPath/i);
  }
});

test('Android intercepts openchamber-asset with blocking progressive InputStream', async () => {
  const [activity, plugin, store, readme] = await Promise.all([
    source('android/app/src/main/java/com/openchamber/app/MainActivity.java'),
    source('android/app/src/main/java/com/openchamber/app/OpenChamberVirtualAssetPlugin.java'),
    source('android/app/src/main/java/com/openchamber/app/OpenChamberVirtualAssetStore.java'),
    source('README.md'),
  ]);

  assert.match(activity, /registerPlugin\(OpenChamberVirtualAssetPlugin\.class\)/);
  assert.match(plugin, /@CapacitorPlugin\(name = "OpenChamberVirtualAsset"\)/);
  assert.match(plugin, /class VirtualAssetWebViewClient extends BridgeWebViewClient/);
  assert.match(plugin, /shouldInterceptRequest/);
  assert.match(plugin, /OpenChamberVirtualAssetStore\.extractAssetId/);
  assert.match(plugin, /OpenChamberVirtualAssetStore\.openStream/);
  assert.match(plugin, /new WebResourceResponse\(mime, null, 200, "OK", headers, stream\)/);
  assert.match(store, /static final String SCHEME = "openchamber-asset"/);
  assert.match(store, /static final long TTL_MILLIS = 120_000L/);
  assert.match(store, /static final int MAX_CONCURRENT_ASSETS = 16/);
  assert.match(store, /static final int MAX_ASSET_BYTES = 32 \* 1024 \* 1024/);
  assert.match(store, /static final int MAX_QUEUED_BYTES = 4 \* 1024 \* 1024/);
  assert.match(store, /static String normalizeImageMime\(String mime\)/);
  assert.match(store, /indexOf\('\\n'\) >= 0 \|\| normalized\.indexOf\('\\r'\) >= 0 \|\| normalized\.indexOf\('\\0'\) >= 0/);
  assert.match(store, /startsWith\("image\/"\)/);
  assert.match(store, /asset\.activeReaders > 0/);
  assert.match(store, /Asset already has an active reader/);
  assert.match(store, /class AssetInputStream extends InputStream/);
  assert.match(store, /asset\.condition\.await/);
  assert.match(store, /static void cancel\(String assetId\)/);
  assert.match(plugin, /headers\.put\("X-Content-Type-Options", "nosniff"\)/);
  assert.match(readme, /OpenChamberVirtualAsset/);
  assert.match(readme, /openchamber-asset:\/\/v\/\{assetId\}/);
  assert.match(readme, /WKURLSchemeHandler/);
  assert.match(readme, /blocking `InputStream`/);
  assert.match(readme, /image\/\*[\s`]*only/);
  assert.match(readme, /X-Content-Type-Options: nosniff/);
  assert.match(readme, /[Oo]ne reader per asset/);
  for (const content of [store, plugin]) {
    assert.doesNotMatch(content, /relay.*token|bearerToken|hostPath/i);
  }
});

test('virtual asset URL contract has no host path or credentials', async () => {
  const [ts, iosStore, androidStore] = await Promise.all([
    source('src/openchamber-virtual-asset.ts'),
    source('ios/App/App/OpenChamberVirtualAssetStore.swift'),
    source('android/app/src/main/java/com/openchamber/app/OpenChamberVirtualAssetStore.java'),
  ]);
  assert.match(ts, /VIRTUAL_ASSET_SCHEME\}:\/\/v\/\$\{encodeURIComponent\(assetId\)\}/);
  // Swift string interpolation: "\(scheme)://\(urlHost)/\(assetId)"
  assert.match(iosStore, /"\\\(scheme\):\/\/\\\(urlHost\)\/\\\(assetId\)"/);
  assert.match(androidStore, /SCHEME \+ ":\/\/" \+ URL_HOST \+ "\/" \+ assetId/);
  // URL builders must not embed userinfo or secrets.
  assert.doesNotMatch(iosStore, /:\/\/[^/]*@/);
  assert.doesNotMatch(androidStore, /:\/\/[^/]*@/);
  assert.doesNotMatch(iosStore, /getPassword|userInfo|Authorization/);
  assert.doesNotMatch(androidStore, /getPassword|userInfo|Authorization/);
});
