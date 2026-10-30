import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ProceduralAssistantAvatar } from '@/components/assistants/ProceduralAssistantAvatar';
import { AVATAR_PICKER_SHAPES, encodeAssistantAvatar, resolveAssistantAvatar } from '@/lib/assistant-avatar/recipe';
import { createAssistantAvatarPlayer, mountAssistantAvatarRenderer } from '@/lib/assistant-avatar/engine';
import '@/index.css';

const host = document.createElement('main');
document.body.append(host);
const root = createRoot(host);
let commits = 0;
let writes = 0;
let reads = 0;
const setAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (name, value) {
  if (this.closest('[data-procedural-avatar]')) writes++;
  return setAttribute.call(this, name, value);
};
const getRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () {
  if (this.hasAttribute('data-avatar-motion')) reads++;
  return getRect.call(this);
};
const recipeFor = (index: number) => ({ ...resolveAssistantAvatar('performance'), shape: AVATAR_PICKER_SHAPES[index % AVATAR_PICKER_SHAPES.length] });
const frames = async (count: number) => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame); };
const render = (count: number, draft: number) => flushSync(() => root.render(<div data-draft={draft} style={{ display: 'flex', gap: 4 }}>
  {Array.from({ length: count }, (_, i) => <React.Profiler key={i} id={`face-${i}`} onRender={() => { commits++; }}>
    <ProceduralAssistantAvatar seed={encodeAssistantAvatar(recipeFor(i))} size={44} motion="working" />
  </React.Profiler>)}
</div>));

function benchmark(count: number, motion: 'idle' | 'working', randomizeShape = false) {
  const stage = document.createElement('section');
  stage.style.cssText = 'display:flex;gap:4px';
  document.body.append(stage);
  const random = Math.random;
  let seed = 1;
  Math.random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296);
  try {
    const faces = Array.from({ length: count }, (_, i) => {
      const recipe = recipeFor(i), renderer = mountAssistantAvatarRenderer(document, `bench-${i}`, recipe);
      renderer.svg.style.cssText = 'width:44px;height:44px';
      stage.append(renderer.svg);
      const player = createAssistantAvatarPlayer(recipe, `performance-${i}`, motion, true, { randomizeShape });
      player.setGaze([-1, 1]);
      return { renderer, player };
    });
    const samples: number[] = [];
    for (let i = 0; i < 180; i++) {
      const start = performance.now();
      for (const { renderer, player } of faces) renderer.paint(player.advance(1 / 30));
      if (i >= 60) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return { count, motion, randomizeShape, samples: samples.length, median: samples[60], p95: samples[114], max: samples.at(-1)! };
  } finally {
    Math.random = random;
    stage.remove();
  }
}

Object.assign(window, { avatarPerformance: {
  benchmark,
  commits: () => commits,
  pointerBurst() {
    const before = { reads, writes, commits };
    for (let i = 0; i < 1000; i++) window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: i, clientY: 100 }));
    return { reads: reads - before.reads, writes: writes - before.writes, commits: commits - before.commits };
  },
  async mount(count: number, draft = 0) {
    render(count, draft);
    await frames(3);
  },
  async steady() {
    const before = { commits, writes };
    await frames(4);
    return { commits: commits - before.commits, writes: writes - before.writes, active: host.querySelectorAll('[data-avatar-active="true"]').length };
  },
  updateUnrelated() {
    const before = writes;
    for (let i = 0; i < 50; i++) render(20, i);
    return { writes: writes - before };
  },
  async unmount() { flushSync(() => root.render(null)); await frames(3); },
} });
