import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useResolvedImageSource, fetchRuntimeImageObjectUrl, releaseRuntimeImageObjectUrl } from '@/components/chat/imageSource';

const root = createRoot(document.getElementById('root')!);
export function Image({ path, cached }: { path: string; cached: boolean }) {
  const cachedSource = useResolvedImageSource(cached ? path : '', '/workspace');
  const [legacySource, setLegacySource] = React.useState('');
  React.useEffect(() => {
    if (cached) return;
    const controller = new AbortController();
    let url = '';
    void fetchRuntimeImageObjectUrl(path, controller.signal).then((result) => {
      if (controller.signal.aborted) { releaseRuntimeImageObjectUrl(result); return; }
      url = result; setLegacySource(result);
    });
    return () => { controller.abort(); releaseRuntimeImageObjectUrl(url); };
  }, [cached, path]);
  return <img src={(cached ? cachedSource : legacySource) || undefined} width="128" height="160" />;
}
async function show(cached: boolean, preview = false) {
  const start = performance.now();
  flushSync(() => root.render(<>{Array.from({ length: preview ? 8 : 4 }, (_, index) =>
    <Image key={index} path={`/workspace/image-${index % 4}.png`} cached={cached} />)}</>));
  const images = Array.from(document.images);
  await Promise.all(images.map(async (image) => {
    for (let attempt = 0; attempt < 1500 && (!image.src || !image.naturalWidth); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!image.naturalWidth) throw new Error('Image did not load');
    await image.decode();
  }));
  return performance.now() - start;
}
async function hide() {
  flushSync(() => root.render(null));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
Object.assign(window, { runImageBenchmark: async (cached: boolean) => {
  await hide();
  const cold = await show(cached);
  const preview = await show(cached, true);
  const warm = [];
  for (let i = 0; i < 10; i++) { await hide(); warm.push(await show(cached)); }
  const urls = Array.from(document.images, (image) => image.src);
  await hide();
  return { cold, preview, warm, urls };
} });
