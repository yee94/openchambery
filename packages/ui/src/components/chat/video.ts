export const isVideoSource = (source: string, mimeType?: string): boolean => (
  Boolean(mimeType?.toLowerCase().startsWith('video/'))
  || /^data:video\//i.test(source)
  || /\.(?:mp4|m4v|webm|mov|ogv|ogg)(?:[?#]|$)/i.test(source)
);
