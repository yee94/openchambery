import { createAssistantAvatarPlayer, mountAssistantAvatarRenderer } from './engine';
import { subscribeAvatarFrames } from './frameClock';
import { acquireAvatarPointer } from './pointerTracker';
import { resolveAssistantAvatar, type AvatarMotion } from './recipe';

/** One DOM owner. React and non-React callers only supply identity and live state. */
export function mountAvatarAnimation(host: HTMLElement, { id, seed, randomizeShape = false }: { id: string; seed?: string; randomizeShape?: boolean }) {
  const recipe = resolveAssistantAvatar(seed);
  const renderer = mountAssistantAvatarRenderer(host.ownerDocument, id, recipe);
  host.append(renderer.svg);
  let player: ReturnType<typeof createAssistantAvatarPlayer> | null = null;
  let stop: (() => void) | null = null;
  let disposed = false;

  return {
    update({ active, motion, size }: { active: boolean; motion: AvatarMotion; size: number }) {
      if (disposed) return;
      if (!active || !recipe.animate) {
        if (stop) {
          stop(); stop = null; player = null;
          renderer.still();
        }
        return;
      }
      if (player) {
        player.setCompact(size < 48);
        player.setMotion(motion);
        return;
      }
      const win = host.ownerDocument.defaultView;
      if (!win) return;
      const live = createAssistantAvatarPlayer(recipe, seed ?? 'default', motion, size < 48, { randomizeShape });
      player = live;
      const pointer = acquireAvatarPointer(win);
      let gaze: [number, number] | null = null;
      let previousGaze: [number, number] | null = null;
      let previous = performance.now();
      const unsubscribe = subscribeAvatarFrames((timestamp) => {
        if (gaze?.[0] !== previousGaze?.[0] || gaze?.[1] !== previousGaze?.[1]) {
          live.setGaze(gaze);
          previousGaze = gaze;
        }
        renderer.paint(live.advance((timestamp - previous) / 1000));
        previous = timestamp;
      }, () => {
        gaze = null;
        const point = pointer.read();
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
      stop = () => { unsubscribe(); pointer.release(); };
    },
    hover() { if (!disposed) player?.hover(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop?.(); stop = null; player = null;
      renderer.svg.remove();
    },
  };
}
