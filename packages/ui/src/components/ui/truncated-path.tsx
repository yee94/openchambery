import { cn } from '@/lib/utils';
import { splitTruncatedPath } from '@/lib/truncatePathDisplay';

type TruncatedPathProps = {
  path: string;
  className?: string;
  title?: string;
  dirClassName?: string;
  nameClassName?: string;
};

export function TruncatedPath({
  path,
  className,
  title,
  dirClassName = 'text-muted-foreground',
  nameClassName = 'text-foreground',
}: TruncatedPathProps) {
  const { prefix, parent, stem, ext, leadingSlash } = splitTruncatedPath(path);
  const hasDir = Boolean(prefix || parent);

  return (
    <span className={cn('flex min-w-0 items-baseline overflow-hidden', className)} title={title ?? path}>
      {leadingSlash ? <span className={cn('shrink-0', dirClassName)}>/</span> : null}
      {prefix ? (
        <span className={cn('min-w-0 shrink-[9999] truncate', dirClassName)}>{prefix}</span>
      ) : null}
      {parent ? (
        <span className={cn('shrink-0', dirClassName)}>
          {prefix ? '/' : ''}
          {parent}
        </span>
      ) : null}
      <span className="flex min-w-0 shrink items-baseline">
        {hasDir ? <span className={dirClassName}>/</span> : null}
        <span className={cn('min-w-0 truncate', nameClassName)}>{stem}</span>
        {ext ? <span className={cn('shrink-0', nameClassName)}>{ext}</span> : null}
      </span>
    </span>
  );
}
