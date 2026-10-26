import React from 'react';
import wordmarkUrl from '@/assets/brand/yuri-wordmark.svg';

export function YuriWordmark({ className = '', width = 112 }: { className?: string; width?: React.CSSProperties['width'] }) {
  return (
    <span
      role="img"
      aria-label="Yuri"
      className={`inline-block shrink-0 ${className}`}
      style={{
        width,
        aspectRatio: '626.723 / 280',
        backgroundColor: 'currentColor',
        mask: `url("${wordmarkUrl}") center / contain no-repeat`,
        WebkitMask: `url("${wordmarkUrl}") center / contain no-repeat`,
      }}
    />
  );
}
