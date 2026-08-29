import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import { getClientPlatform, isCapacitorApp } from '@/lib/platform';

export const NATIVE_IOS_COMPOSER_CLASS = 'oc-native-ios-composer';
export const NATIVE_IOS_COMPOSER_HEIGHT_VAR = '--oc-native-composer-height';
const NATIVE_IOS_COMPOSER_PLUGIN = 'OpenChamberComposer';

export type NativeIosComposerAppearance = 'dark' | 'light';

export type NativeIosComposerState = {
  text: string;
  placeholder: string;
  modelLabel: string;
  canSend: boolean;
  canAbort: boolean;
  attachmentCount: number;
  appearance: NativeIosComposerAppearance;
  attachAria: string;
  sendAria: string;
  stopAria: string;
  modelAria: string;
  suppressed: boolean;
};

type OpenChamberComposerPlugin = {
  present: (state: NativeIosComposerState) => Promise<void>;
  update: (state: Partial<NativeIosComposerState>) => Promise<void>;
  dismiss: () => Promise<void>;
  setSuppressed: (options: { suppressed: boolean }) => Promise<void>;
  focus: () => Promise<void>;
  blur: () => Promise<void>;
  addListener: (
    event: NativeIosComposerEventName,
    listener: (payload: NativeIosComposerEventPayload) => void,
  ) => Promise<PluginListenerHandle>;
};

export type NativeIosComposerEventName =
  | 'textChanged'
  | 'send'
  | 'abort'
  | 'attach'
  | 'openModel'
  | 'heightChanged'
  | 'expandedChanged';

export type NativeIosComposerEventPayload = {
  text?: string;
  height?: number;
  expanded?: boolean;
};

const OpenChamberComposer = registerPlugin<OpenChamberComposerPlugin>(NATIVE_IOS_COMPOSER_PLUGIN);

export type NativeIosComposerAvailabilityInput = {
  isCapacitor: boolean;
  platform: string;
  pluginAvailable: boolean;
  isMobile: boolean;
};

export const evaluateNativeIosComposerAvailability = (
  input: NativeIosComposerAvailabilityInput,
): boolean => input.isCapacitor && input.platform === 'ios' && input.pluginAvailable && input.isMobile;

/** True only on Capacitor iPhone/iPad when the native composer plugin is registered. */
export function canUseNativeIosComposer(isMobile: boolean): boolean {
  if (typeof window === 'undefined') return false;
  return evaluateNativeIosComposerAvailability({
    isCapacitor: isCapacitorApp(),
    platform: getClientPlatform(),
    pluginAvailable: Capacitor.isPluginAvailable(NATIVE_IOS_COMPOSER_PLUGIN),
    isMobile,
  });
}

export const nativeIosComposerAppearanceFromRoot = (root: { classList: { contains: (name: string) => boolean } }): NativeIosComposerAppearance => (
  root.classList.contains('dark') ? 'dark' : 'light'
);

export const parseNativeComposerHeight = (payload: NativeIosComposerEventPayload | null | undefined): number => {
  const height = payload?.height;
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) return 0;
  return height;
};

export const applyNativeComposerHeightVar = (root: HTMLElement, height: number): void => {
  if (!(height > 0)) {
    root.style.removeProperty(NATIVE_IOS_COMPOSER_HEIGHT_VAR);
    return;
  }
  root.style.setProperty(NATIVE_IOS_COMPOSER_HEIGHT_VAR, `${Math.round(height)}px`);
};

export const setNativeComposerDocumentClass = (root: HTMLElement, active: boolean): void => {
  root.classList.toggle(NATIVE_IOS_COMPOSER_CLASS, active);
  if (!active) root.style.removeProperty(NATIVE_IOS_COMPOSER_HEIGHT_VAR);
};

export const nativeComposerStatesEqual = (
  left: NativeIosComposerState,
  right: NativeIosComposerState,
): boolean => (
  left.text === right.text
  && left.placeholder === right.placeholder
  && left.modelLabel === right.modelLabel
  && left.canSend === right.canSend
  && left.canAbort === right.canAbort
  && left.attachmentCount === right.attachmentCount
  && left.appearance === right.appearance
  && left.attachAria === right.attachAria
  && left.sendAria === right.sendAria
  && left.stopAria === right.stopAria
  && left.modelAria === right.modelAria
  && left.suppressed === right.suppressed
);

export const getNativeIosComposerPlugin = (): OpenChamberComposerPlugin => OpenChamberComposer;
