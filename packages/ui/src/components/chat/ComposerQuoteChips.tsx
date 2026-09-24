import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';

export function ComposerQuoteChips({ quotes, onRemove, removeLabel }: {
  quotes: readonly string[];
  onRemove: (index: number) => void;
  removeLabel: string;
}) {
  if (quotes.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 px-3 pt-3" data-composer-quote-list>
      {quotes.map((quote, index) => (
        <div
          key={quote}
          data-composer-quote-chip
          className="flex min-w-0 items-center gap-1 rounded-md bg-[var(--surface-muted)] py-0.5 pl-2 pr-0.5"
        >
          <span className="min-w-0 flex-1 truncate border-l-2 border-border pl-2 typography-meta text-muted-foreground">{quote.replace(/\s+/g, ' ')}</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => onRemove(index)} aria-label={removeLabel}>
            <Icon name="close" className="size-3" />
          </Button>
        </div>
      ))}
    </div>
  );
}
