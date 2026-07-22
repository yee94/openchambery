import React from 'react';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { StopIcon } from '@/components/icons/StopIcon';
import { Textarea } from '@/components/ui/textarea';
import { ChatComposerSurface } from './ChatComposerSurface';

export type ChatPromptAttachment = {
  id: string;
  url: string;
  name: string;
  mime: string;
};

type ChatPromptComposerProps = Omit<React.ComponentProps<typeof ChatComposerSurface>, 'children' | 'onChange'> & {
  value: string;
  attachments?: readonly ChatPromptAttachment[];
  disabled?: boolean;
  pending?: boolean;
  placeholder?: string;
  isMobile?: boolean;
  onChange: (value: string, event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  onStop?: () => void;
  onAddFiles?: (files: FileList | null) => void;
  onRemoveAttachment?: (id: string) => void;
  addFilesLabel?: string;
  removeAttachmentLabel?: string;
  sendLabel?: string;
  stopLabel?: string;
  hint?: React.ReactNode;
  leftControls?: React.ReactNode;
  rightControls?: React.ReactNode;
  footerContent?: React.ReactNode;
  inputHeader?: React.ReactNode;
  attachmentContent?: React.ReactNode;
  highlightedContent?: React.ReactNode;
  highlightRef?: React.Ref<HTMLDivElement>;
  inputRef?: React.Ref<HTMLTextAreaElement>;
  textareaProps?: Omit<React.ComponentProps<typeof Textarea>, 'value' | 'disabled' | 'placeholder' | 'onChange' | 'ref'>;
  textLayoutClassName?: string;
  inputClassName?: string;
  inputOuterClassName?: string;
  inputStyle?: React.CSSProperties;
  footerClassName?: string;
  footerStyle?: React.CSSProperties;
  contentClassName?: string;
  inputSectionClassName?: string;
  autoResize?: boolean;
  disableInputWhilePending?: boolean;
  children?: React.ReactNode;
};

const ChatPromptTextarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<typeof Textarea>>((props, ref) => (
  <Textarea ref={ref} {...props} />
));

ChatPromptTextarea.displayName = 'ChatPromptTextarea';

const ChatPromptFooter: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, children, ...props }) => (
  <div
    className={cn('flex shrink-0 items-center gap-2 bg-transparent px-2.5 py-1.5', className)}
    data-chat-input-footer="true"
    {...props}
  >
    {children}
  </div>
);

const setRef = <T,>(ref: React.Ref<T> | undefined, value: T | null) => {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
};

export const ChatPromptComposer: React.FC<ChatPromptComposerProps> = ({
  value,
  attachments = [],
  disabled = false,
  pending = false,
  placeholder,
  isMobile = false,
  onChange,
  onSubmit,
  onStop,
  onAddFiles,
  onRemoveAttachment,
  addFilesLabel,
  removeAttachmentLabel,
  sendLabel,
  stopLabel,
  hint,
  leftControls,
  rightControls,
  footerContent,
  inputHeader,
  attachmentContent,
  highlightedContent,
  highlightRef,
  inputRef,
  textareaProps,
  textLayoutClassName,
  inputClassName,
  inputOuterClassName,
  inputStyle,
  footerClassName,
  footerStyle,
  contentClassName,
  inputSectionClassName,
  autoResize = true,
  disableInputWhilePending = true,
  children,
  className,
  expanded = false,
  ...surfaceProps
}) => {
  const localInputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useLayoutEffect(() => {
    if (!autoResize || expanded || textareaProps?.fillContainer) return;
    const textarea = localInputRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const maxHeight = Number.parseFloat(window.getComputedStyle(textarea).maxHeight);
    const nextHeight = Number.isFinite(maxHeight) ? Math.min(textarea.scrollHeight, maxHeight) : textarea.scrollHeight;
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = Number.isFinite(maxHeight) && textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [autoResize, expanded, textareaProps?.fillContainer, value]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    textareaProps?.onKeyDown?.(event);
    if (event.defaultPrevented || isIMECompositionEvent(event)) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!disabled && (!pending || !disableInputWhilePending)) onSubmit();
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    onAddFiles?.(event.target.files);
    event.target.value = '';
  };

  const hasContent = value.trim().length > 0 || attachments.length > 0;
  const defaultLeftControls = onAddFiles ? (
    <>
      <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
      <button
        type="button"
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground outline-none hover:bg-[var(--interactive-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled || pending}
        aria-label={addFilesLabel}
      >
        <Icon name="attachment-2" className="size-[18px]" />
      </button>
    </>
  ) : null;
  const defaultRightControls = pending && onStop ? (
    <button
      type="button"
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--status-error)] outline-none hover:bg-[var(--interactive-hover)]"
      onClick={onStop}
      aria-label={stopLabel}
    >
      <StopIcon className="size-5" />
    </button>
  ) : (
    <button
      type="submit"
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-primary outline-none hover:bg-[var(--interactive-hover)] disabled:cursor-not-allowed disabled:opacity-30"
      disabled={disabled || pending || !hasContent}
      aria-label={sendLabel}
    >
      <Icon name={pending ? 'loader-4' : 'send-plane-2'} className={cn('size-4', pending && 'animate-spin')} />
    </button>
  );

  return (
    <ChatComposerSurface className={className} expanded={expanded} {...surfaceProps}>
      {children}
      <div className={cn('relative flex min-h-0 flex-col', expanded && 'flex-1', contentClassName)}>
        <div className={cn('overflow-hidden', expanded && 'flex min-h-0 flex-1 flex-col', inputSectionClassName)}>
          {inputHeader}
          {attachmentContent}
          {attachments.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto px-3 pt-3" data-chat-prompt-attachments="true">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="group relative shrink-0">
                  {attachment.mime.startsWith('image/') ? (
                    <img src={attachment.url} alt={attachment.name} className="size-16 rounded-lg border border-border object-cover" />
                  ) : (
                    <div className="flex h-16 max-w-40 items-center gap-2 rounded-lg border border-border px-3 typography-meta">
                      <Icon name="attachment-2" className="size-4 shrink-0" />
                      <span className="truncate">{attachment.name}</span>
                    </div>
                  )}
                  {onRemoveAttachment ? (
                    <button
                      type="button"
                      className="absolute -right-1 -top-1 flex size-6 items-center justify-center rounded-full border border-border bg-[var(--surface-elevated)] shadow-sm hover:bg-[var(--interactive-hover)]"
                      onClick={() => onRemoveAttachment(attachment.id)}
                      aria-label={removeAttachmentLabel}
                    >
                      <Icon name="close" className="size-3" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          <div className={cn('relative overflow-hidden', expanded && 'flex min-h-0 flex-1 flex-col')}>
            {highlightedContent ? (
              <div
                ref={highlightRef}
                aria-hidden
                className={cn('pointer-events-none absolute inset-0 z-0 rounded-b-none', textLayoutClassName, inputClassName)}
              >
                {highlightedContent}
              </div>
            ) : null}
            <ChatPromptTextarea
              {...textareaProps}
              simple
              ref={(node) => {
                localInputRef.current = node;
                setRef(inputRef, node);
              }}
              data-chat-input="true"
              value={value}
              onChange={(event) => onChange(event.target.value, event)}
              onKeyDown={handleKeyDown}
              disabled={disabled || (pending && disableInputWhilePending)}
              placeholder={placeholder}
              enterKeyHint={isMobile ? 'send' : textareaProps?.enterKeyHint}
              outerClassName={cn('ring-0 bg-transparent shadow-none hover:bg-transparent focus-within:ring-0', expanded && 'min-h-0 flex-1', inputOuterClassName)}
              className={cn(
                'relative z-10 min-h-[52px] max-h-40 resize-none appearance-none rounded-b-none border-0 bg-transparent px-3 pb-2 pt-4 typography-markdown hover:border-transparent md:typography-ui-label',
                textLayoutClassName,
                inputClassName,
                highlightedContent && 'text-transparent caret-[var(--surface-foreground)]',
              )}
              style={inputStyle}
              rows={textareaProps?.rows ?? 1}
            />
          </div>
        </div>
        <ChatPromptFooter
          className={footerClassName}
          style={footerStyle}
        >
          {footerContent ?? (
            <>
              <div className="flex items-center gap-1.5">{leftControls ?? defaultLeftControls}</div>
              {hint ? <div className="min-w-0 flex-1 truncate typography-micro text-muted-foreground">{hint}</div> : <div className="flex-1" />}
              <div className="flex items-center gap-1.5">{rightControls ?? defaultRightControls}</div>
            </>
          )}
        </ChatPromptFooter>
      </div>
    </ChatComposerSurface>
  );
};
