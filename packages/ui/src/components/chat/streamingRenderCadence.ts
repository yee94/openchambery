import type { ClientPlatform } from '@/lib/platform';

type StreamingRenderCadence = {
  textThrottleMs: number;
  markdownPaceMs: number;
};

const DEFAULT_STREAMING_RENDER_CADENCE: StreamingRenderCadence = {
  textThrottleMs: 20,
  markdownPaceMs: 64,
};

const ANDROID_STREAMING_RENDER_CADENCE: StreamingRenderCadence = {
  textThrottleMs: 100,
  markdownPaceMs: 128,
};

export const resolveStreamingRenderCadence = (platform: ClientPlatform): StreamingRenderCadence => {
  return platform === 'android'
    ? ANDROID_STREAMING_RENDER_CADENCE
    : DEFAULT_STREAMING_RENDER_CADENCE;
};
