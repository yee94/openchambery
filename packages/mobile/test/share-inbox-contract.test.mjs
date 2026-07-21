import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('share inbox persists relative paths and enforces decoded image upload limits', async () => {
  const [readme, ios, android] = await Promise.all([
    source('README.md'),
    source('ios/App/App/OpenChamberShareStore.swift'),
    source('android/app/src/main/java/com/openchamber/app/OpenChamberShareStore.java'),
  ]);
  for (const content of [ios, android]) {
    assert.match(content, /8L? \* 1024 \* 1024/);
    assert.match(content, /16L? \* 1024 \* 1024/);
    assert.match(content, /consumedAt/);
  }
  assert.match(ios, /copyLimited\(from: item\.0, to: destination, maximum: maximumImageBytes\)/);
  assert.match(android, /copyLimited\(context\.getContentResolver\(\)\.openInputStream\(uri\), output, MAX_IMAGE_BYTES\)/);
  assert.match(readme, /base64-decoded image to 8 MiB and each operation to 16 MiB/);
  assert.match(ios, /destination\.lastPathComponent/);
  assert.match(android, /output\.getName\(\)/);
  assert.match(android, /getContentResolver\(\)\.getType\(uri\)/);
  assert.match(android, /put\("mime", mime\)/);
});

test('Android sharing shortcut contract declares its target and category', async () => {
  const [xml, manifest, store, receiver] = await Promise.all([
    source('android/app/src/main/res/xml/share_shortcuts.xml'),
    source('android/app/src/main/AndroidManifest.xml'),
    source('android/app/src/main/java/com/openchamber/app/OpenChamberShareStore.java'),
    source('android/app/src/main/java/com/openchamber/app/ShareReceiverActivity.java'),
  ]);
  assert.match(xml, /share-target android:targetClass="com\.openchamber\.app\.ShareReceiverActivity"/);
  assert.match(xml, /android:mimeType="text\/plain"/);
  assert.match(xml, /android:mimeType="image\/\*"/);
  assert.match(xml, /com\.openchamber\.app\.SHARE_ASSISTANT/);
  assert.match(manifest, /<activity android:name="\.ShareReceiverActivity"[\s\S]*android\.app\.shortcuts/);
  assert.match(store, /setCategories\(java\.util\.Collections\.singleton\(ShareReceiverActivity\.SHARE_TARGET_CATEGORY\)\)/);
  assert.match(receiver, /Intent\.EXTRA_SHORTCUT_ID/);
});

test('iOS sharing resolves public.image files to concrete, signature-verified MIME types', async () => {
  const [controller, store] = await Promise.all([
    source('ios/App/OpenChamberShareExtension/ShareViewController.swift'),
    source('ios/App/App/OpenChamberShareStore.swift'),
  ]);
  assert.doesNotMatch(controller, /"image\/\*"/);
  assert.match(controller, /imageMIME\(for: temporary\)/);
  assert.match(controller, /case "jpg", "jpeg":/);
  assert.match(controller, /"image\/jpeg"/);
  assert.match(controller, /case "png":/);
  assert.match(controller, /"image\/png"/);
  assert.match(controller, /case "gif":/);
  assert.match(controller, /"image\/gif"/);
  assert.match(controller, /case "webp":/);
  assert.match(controller, /"image\/webp"/);
  assert.match(controller, /case "heic", "heif":/);
  assert.match(controller, /"image\/heic"/);
  assert.match(controller, /hasHEICSignature/);
  assert.match(controller, /ShareError\.unrecognizedImage/);
  assert.match(store, /unrecognizedImage/);
});
