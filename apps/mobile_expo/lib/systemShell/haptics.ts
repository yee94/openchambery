import { Platform } from 'react-native';

/**
 * Cap OpenChamberHaptics: impactLight / impactMedium / impactHeavy.
 * Backed by expo-haptics (UIImpactFeedbackGenerator / Android vibrator).
 */
export async function impactLight(): Promise<void> {
  if (Platform.OS === 'web') return;
  const Haptics = await import('expo-haptics');
  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

export async function impactMedium(): Promise<void> {
  if (Platform.OS === 'web') return;
  const Haptics = await import('expo-haptics');
  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
}

export async function impactHeavy(): Promise<void> {
  if (Platform.OS === 'web') return;
  const Haptics = await import('expo-haptics');
  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
}
