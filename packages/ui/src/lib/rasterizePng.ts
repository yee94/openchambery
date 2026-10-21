/** Rasterize a local image for native surfaces that cannot display SVG. */
export const rasterizePngBase64 = (src: string, size: number): Promise<string | null> => {
  if (typeof document === 'undefined' || !src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, size, size);
        const dataUrl = canvas.toDataURL('image/png');
        const comma = dataUrl.indexOf(',');
        resolve(comma >= 0 ? dataUrl.slice(comma + 1) : null);
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
};
