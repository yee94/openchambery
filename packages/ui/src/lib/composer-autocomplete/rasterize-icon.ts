import { ICON_STROKE_WIDTH } from '@/components/icon/Icon';
import { iconSpriteData } from '@/components/icon/sprite';

const RASTER_ICON_PX = 32;

export const spriteIconSvgMarkup = (name: string, color: string): string | null => {
  const content = iconSpriteData[name as keyof typeof iconSpriteData];
  if (typeof content !== 'string' || content.length === 0) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${ICON_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round">${content}</svg>`;
};

export const rasterizeSpriteIconPngBase64 = (name: string, color: string): Promise<string | null> => {
  const markup = spriteIconSvgMarkup(name, color);
  if (!markup || typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = RASTER_ICON_PX;
        canvas.height = RASTER_ICON_PX;
        const context = canvas.getContext('2d');
        if (!context) {
          resolve(null);
          return;
        }
        context.clearRect(0, 0, RASTER_ICON_PX, RASTER_ICON_PX);
        context.drawImage(image, 0, 0, RASTER_ICON_PX, RASTER_ICON_PX);
        const dataUrl = canvas.toDataURL('image/png');
        const comma = dataUrl.indexOf(',');
        resolve(comma >= 0 ? dataUrl.slice(comma + 1) : null);
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });
};
