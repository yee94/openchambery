import React from 'react';
import { cn } from '@/lib/utils';

interface QuestionCardFrameProps {
  header: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  afterBody?: React.ReactNode;
  mobile?: boolean;
  questionCard?: boolean;
  onInteraction?: React.ReactEventHandler<HTMLDivElement>;
}

/** Shared visual frame for transcript interactions, based on QuestionCard. */
export function QuestionCardFrame({
  header,
  children,
  footer,
  afterBody,
  mobile = false,
  questionCard = false,
  onInteraction,
}: QuestionCardFrameProps) {
  return (
    <div className="group w-full pt-0 pb-2">
      <div className="chat-column">
        <div
          data-interaction-card
          data-question-card={questionCard ? '' : undefined}
          className="-mt-1 overflow-hidden rounded-xl border border-border/30 bg-muted/10"
          onPointerDownCapture={onInteraction}
          onClickCapture={onInteraction}
          onKeyDownCapture={onInteraction}
          onInputCapture={onInteraction}
          onPasteCapture={onInteraction}
          onCompositionStartCapture={onInteraction}
        >
          <div className={cn(
            'border-b border-border/20',
            mobile ? 'px-3 py-2' : 'px-2 py-1.5',
          )}>
            {header}
          </div>
          <div className={cn(mobile ? 'px-3 py-3' : 'px-2 py-2')}>
            {children}
          </div>
          {afterBody}
          {footer ? (
            <div className={cn(
              'flex flex-wrap items-center gap-1.5 border-t border-border/20',
              mobile ? 'px-3 py-2' : 'px-2 pb-1.5 pt-1',
            )}>
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
