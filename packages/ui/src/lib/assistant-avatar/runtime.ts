import { createAssistantAvatarPlayer, mountAssistantAvatarRenderer } from './engine';
import { subscribeAvatarFrames } from './frameClock';
import { acquireAvatarPointer } from './pointerTracker';
import { resolveAssistantAvatar, type AvatarMotion, type AvatarEyeColor } from './recipe';

/** One DOM owner. React and non-React callers only supply identity and live state. */
export function mountAvatarAnimation(host: HTMLElement, { id, seed, randomizeShape = false, eyeColor }: { id: string; seed?: string; randomizeShape?: boolean; eyeColor?: AvatarEyeColor }) {
  const recipe = resolveAssistantAvatar(seed);
  const renderer = mountAssistantAvatarRenderer(host.ownerDocument, id, recipe, eyeColor);
  host.append(renderer.svg);
  let player: ReturnType<typeof createAssistantAvatarPlayer> | null = null;
  let stop: (() => void) | null = null;
  let disposed = false;
  let state: { active: boolean; motion: AvatarMotion; size: number } = { active: false, motion: 'idle', size: 0 };
  const resting = () => state.motion === 'idle' && !randomizeShape;

  const reset = () => {
    if (!stop) return;
    stop(); stop = null; player = null;
    renderer.still();
  };
  const start = () => {
    if (player) return;
    const win = host.ownerDocument.defaultView;
    if (!win) return;
    const live = createAssistantAvatarPlayer(recipe, seed ?? 'default', state.motion, state.size < 48, { randomizeShape, eyeColor, resting: resting() });
    player = live;
    const pointer = resting() ? null : acquireAvatarPointer(win);
    let gaze: [number, number] | null = null;
    let previousGaze: [number, number] | null = null;
    let previous = performance.now();
    const unsubscribe = subscribeAvatarFrames((timestamp) => {
      if (gaze?.[0] !== previousGaze?.[0] || gaze?.[1] !== previousGaze?.[1]) {
        live.setGaze(gaze);
        previousGaze = gaze;
      }
      const sample = live.advance((timestamp - previous) / 1000);
      renderer.paint(sample);
      previous = timestamp;
      if (resting() && !sample.hovering) reset();
    }, () => {
      gaze = null;
      const point = pointer?.read();
      if (!point) return;
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // Anatomy's width-based reach, with positive y pointing upwards.
      const reach = rect.width * 2;
      gaze = [
        Math.max(-1, Math.min(1, (point.x - rect.left - rect.width / 2) / reach)),
        Math.max(-1, Math.min(1, -(point.y - rect.top - rect.height / 2) / reach)),
      ];
    });
    stop = () => { unsubscribe(); pointer?.release(); };
  };

  return {
    update(next: { active: boolean; motion: AvatarMotion; size: number }) {
      if (disposed) return;
      const wasResting = resting();
      state = { ...next, active: next.active && recipe.animate };
      if (!state.active || wasResting !== resting()) reset();
      if (!state.active) return;
      if (player) {
        player.setCompact(state.size < 48);
        player.setMotion(state.motion);
      } else if (!resting()) start();
    },
    hover() {
      if (disposed || !state.active) return;
      start();
      player?.hover();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop?.(); stop = null; player = null;
      renderer.svg.remove();
    },
  };
}
