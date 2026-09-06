import { Platform } from 'react-native';

/**
 * Cap OpenChamberMedia subset reachable via Expo modules:
 * - Image / HEIC pick via expo-image-picker (iOS converts HEIC when requested as jpeg)
 * - No Cap WebView saveImage path claimed here
 */
export type PickedMedia = {
  uri: string;
  mimeType: string | null;
  fileName: string | null;
  width?: number;
  height?: number;
  /** True when source was HEIC/HEIF and Expo returned a converted asset. */
  convertedFromHeic?: boolean;
};

export async function pickMedia(options?: {
  allowsMultipleSelection?: boolean;
  /** Prefer jpeg so HEIC virtual assets become uploadable. */
  preferJpeg?: boolean;
}): Promise<PickedMedia[]> {
  const ImagePicker = await import('expo-image-picker');
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return [];

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: options?.allowsMultipleSelection ?? false,
    quality: 1,
    exif: false,
    ...(options?.preferJpeg !== false
      ? { preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode?.Compatible }
      : {}),
  });

  if (result.canceled) return [];

  return result.assets.map((asset) => {
    const mime = asset.mimeType ?? null;
    const name = asset.fileName ?? null;
    const heic =
      (mime?.toLowerCase().includes('heic') || mime?.toLowerCase().includes('heif') ||
        name?.toLowerCase().endsWith('.heic') ||
        name?.toLowerCase().endsWith('.heif')) ??
      false;
    const converted =
      heic && mime != null && !mime.toLowerCase().includes('heic') && !mime.toLowerCase().includes('heif');
    return {
      uri: asset.uri,
      mimeType: mime,
      fileName: name,
      width: asset.width,
      height: asset.height,
      convertedFromHeic: converted || undefined,
    };
  });
}

export async function createVirtualAssetFromUri(
  assetId: string,
  mime: string,
  base64Chunks: string[],
): Promise<{ url: string }> {
  const { virtualAssetNative } = await import('openchamber-system-shell');
  await virtualAssetNative.create(assetId, mime);
  for (const chunk of base64Chunks) {
    await virtualAssetNative.append(assetId, chunk);
  }
  return virtualAssetNative.finish(assetId);
}

export function mediaPlatformNote(): string {
  if (Platform.OS === 'ios') {
    return 'HEIC pick via expo-image-picker; virtual assets via local native module';
  }
  if (Platform.OS === 'android') {
    return 'Gallery pick via expo-image-picker; virtual assets via local native module; no iOS glass';
  }
  return 'media unavailable on web';
}
