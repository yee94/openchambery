import React from 'react';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { SendCircleIcon, StopIcon } from '@/components/icons/StopIcon';
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
  /** Default image/* keeps Chat stacked picker image-only. Contact passes all MIME types. */
  fileAccept?: string;
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
  /** stacked = Chat textarea + footer band. inline = one compact row, send on the right. */
  layout?: 'stacked' | 'inline';
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
  fileAccept = 'image/*',
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
  layout = 'stacked',
  children,
  className,
  expanded = false,
  ...surfaceProps
}) => {
  const inline = layout === 'inline';
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
  const imageAttachments = attachments.filter((attachment) => attachment.mime.startsWith('image/'));
  const fileAttachments = attachments.filter((attachment) => !attachment.mime.startsWith('image/'));
  const defaultLeftControls = onAddFiles ? (
    <>
      <input ref={fileInputRef} type="file" accept={fileAccept} multiple className="hidden" onChange={handleFileChange} />
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
  const sendReady = !disabled && !pending && hasContent;
  const circleGlyphClass = isMobile ? 'size-6' : 'size-full';
  const stackedRightControls = pending && onStop ? (
    <button
      type="button"
      data-composer-stop="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full outline-none hover:opacity-80"
      onClick={onStop}
      aria-label={stopLabel}
    >
      <StopIcon className={circleGlyphClass} />
    </button>
  ) : (
    <button
      type="submit"
      data-composer-send="true"
      data-composer-circle={sendReady ? 'true' : undefined}
      className={cn(
        'flex size-8 shrink-0 items-center justify-center outline-none',
        sendReady
          ? 'rounded-full hover:opacity-80'
          : 'rounded-md text-primary hover:bg-[var(--interactive-hover)] disabled:cursor-not-allowed disabled:opacity-30',
      )}
      disabled={disabled || pending || !hasContent}
      aria-label={sendLabel}
    >
      {sendReady ? (
        <SendCircleIcon className={circleGlyphClass} />
      ) : (
        <Icon name={pending ? 'loader-4' : 'send-plane-2'} className={cn('size-4', pending && 'animate-spin')} />
      )}
    </button>
  );
  const inlineRightControls = pending && onStop ? (
    <button
      type="button"
      data-composer-stop="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full outline-none hover:opacity-80"
      onClick={onStop}
      aria-label={stopLabel}
    >
      <StopIcon className={circleGlyphClass} />
    </button>
  ) : (
    <button
      type="submit"
      data-composer-send="true"
      data-composer-circle="true"
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full outline-none',
        sendReady ? 'hover:opacity-80' : 'cursor-not-allowed opacity-30',
      )}
      disabled={disabled || pending || !hasContent}
      aria-busy={pending || undefined}
      aria-label={sendLabel}
    >
      <SendCircleIcon className={circleGlyphClass} spinning={pending} />
    </button>
  );
  const defaultRightControls = inline ? inlineRightControls : stackedRightControls;
  const inlineLeftControls = leftControls !== undefined ? leftControls : defaultLeftControls;

  return (
    <ChatComposerSurface className={className} expanded={expanded} {...surfaceProps}>
      {/* Autocomplete / overlays (CommandAutocomplete, @-mention, …) are
          absolute bottom-full siblings of the content column — keep them as
          direct surface children so overflow rules on the content column
          cannot clip the slash-command picker. */}
      {children}
      {/* data-composer-content: stable path for the textarea so mobile pill/full
          is CSS-only (same DOM node) rather than a remounting conditional tree. */}
      <div
        data-composer-content="true"
        data-composer-layout={layout}
        className={cn(
          'relative flex min-h-0',
          inline ? 'min-h-12 flex-row items-end' : 'flex-col',
          expanded && 'flex-1',
          contentClassName,
        )}
      >
        <div className={cn(
          'overflow-hidden',
          inline && 'min-w-0 flex-1',
          expanded && 'flex min-h-0 flex-1 flex-col',
          inputSectionClassName,
        )}>
          {inputHeader}
          {attachmentContent}
          {imageAttachments.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto px-3 pt-3" data-chat-prompt-attachments="true">
              {imageAttachments.map((attachment) => (
                <div key={attachment.id} className="group relative shrink-0">
                  <img src={attachment.url} alt={attachment.name} className="size-16 rounded-lg border border-border object-cover" />
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
          {fileAttachments.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-3 pt-3" data-chat-prompt-file-attachments="true">
              {fileAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="relative flex max-w-[12rem] items-center gap-1.5 rounded-lg border border-border bg-[var(--surface-elevated)] px-2 py-1"
                >
                  <Icon name="file-text" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate typography-micro">{attachment.name}</span>
                  {onRemoveAttachment ? (
                    <button
                      type="button"
                      className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-[var(--interactive-hover)]"
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
          <div className={cn('relative overflow-hidden', expanded && 'flex min-h-0 flex-1 flex-col')} data-composer-input-shell="true">
            {highlightedContent ? (
              <div
                ref={highlightRef}
                aria-hidden
                data-composer-highlight="true"
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
                'relative z-10 resize-none overflow-y-hidden appearance-none border-0 bg-transparent typography-markdown hover:border-transparent md:typography-ui-label',
                inline
                  ? 'min-h-8 max-h-32 self-center px-3 py-2 leading-5'
                  : 'min-h-[52px] max-h-40 rounded-b-none px-3 pb-2 pt-4',
                textLayoutClassName,
                inputClassName,
                highlightedContent && 'text-transparent caret-[var(--surface-foreground)]',
              )}
              style={inputStyle}
              rows={textareaProps?.rows ?? 1}
            />
          </div>
        </div>
        {inline ? (
          <>
            {inlineLeftControls ? (
              <div
                className="flex h-12 shrink-0 items-center pl-1.5"
                data-composer-inline-attach="true"
              >
                {inlineLeftControls}
              </div>
            ) : null}
            <div
              className={cn('flex h-12 shrink-0 items-center pr-1.5', footerClassName)}
              style={footerStyle}
              data-composer-inline-send="true"
            >
              {rightControls ?? defaultRightControls}
            </div>
          </>
        ) : (
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
        )}
      </div>
    </ChatComposerSurface>
  );
};
