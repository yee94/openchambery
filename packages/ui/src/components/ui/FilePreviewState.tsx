import type { ReactNode } from 'react';

export function FilePreviewState({ illustration, children }: { illustration: ReactNode; children: ReactNode }) {
  return (
    <div className="relative h-full min-h-[240px]! w-full min-w-0 flex-1 text-center" data-file-preview-state>
      <div className="absolute inset-x-6 top-[calc(50%-4rem)] flex h-20 -translate-y-1/2 items-center justify-center" data-file-preview-illustration>
        {illustration}
      </div>
      <div className="absolute inset-x-6 bottom-4 top-[calc(50%-0.25rem)] overflow-auto">
        <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-5 pb-2">
          {children}
        </div>
      </div>
    </div>
  );
}
