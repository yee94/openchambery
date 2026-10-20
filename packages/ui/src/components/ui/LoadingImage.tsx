import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { ImageLoadingPlaceholder } from './ImageLoadingPlaceholder';

type LoadingImageProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  resourceError?: string | null;
  fill?: boolean;
  placeholderAspectRatio?: number;
};

function ImagePresentation({ resourceError, fill, placeholderAspectRatio, onLoad, onError, style, ...props }: LoadingImageProps) {
  const isMobile = useUIStore((state) => state.isMobile);
  const { t } = useI18n();
  const imageRef = React.useRef<HTMLImageElement>(null);
  const [state, setState] = React.useState<'loading' | 'loaded' | 'error'>('loading');
  const phase = resourceError ? 'error' : state;
  React.useLayoutEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) setState('loaded');
  }, []);
  return (
    <span
      className="oc-image-frame"
      data-image-state={phase}
      data-image-fill={fill || undefined}
      data-image-content={placeholderAspectRatio ? (isMobile ? 'mobile' : 'desktop') : undefined}
      style={placeholderAspectRatio && phase !== 'loaded' ? { aspectRatio: placeholderAspectRatio } : undefined}
      aria-busy={phase === 'loading'}
    >
      <img
        {...props}
        ref={imageRef}
        src={props.src || undefined}
        style={{ ...style, ...(phase !== 'loaded' ? { opacity: 0 } : {}) }}
        onLoad={(event) => { setState('loaded'); onLoad?.(event); }}
        onError={(event) => {
          if (!props.src) return;
          setState('error');
          onError?.(event);
        }}
      />
      {phase === 'loading' && <ImageLoadingPlaceholder />}
      {phase === 'error' && <span className="oc-image-error" role="status">{t('chat.fileAttachment.image.loadFailed')}</span>}
    </span>
  );
}

/** Presentation only: callers retain ownership of resource loading and retry. */
export const LoadingImage = React.memo(function LoadingImage({ resourceError, fill, placeholderAspectRatio, ...props }: LoadingImageProps) {
  return <ImagePresentation key={`${props.src ?? ''}\n${props.srcSet ?? ''}`} {...props} resourceError={resourceError} fill={fill} placeholderAspectRatio={placeholderAspectRatio} />;
});
