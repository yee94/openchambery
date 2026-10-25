import React from 'react';
import { useEvent } from '@reactuses/core';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import type { PairingConnectionPayload } from '@/lib/connectionPayload';
import { useI18n } from '@/lib/i18n';

import { parseConnectionPayload } from './mobileQrScan';

const mobileInputKeyboardProps = {
  autoComplete: 'off',
  autoCorrect: 'off',
  spellCheck: false,
} as const;

export type MobilePairingLinkFormProps = {
  disabled?: boolean;
  isBusy?: boolean;
  /** When the parent panel is collapsed, pass -1 so fields are not tabbable. */
  tabIndex?: number;
  inputClassName: string;
  buttonVariant?: React.ComponentProps<typeof Button>['variant'];
  buttonClassName?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  showPasteButton?: boolean;
  error?: string | null;
  onRedeem: (pairing: PairingConnectionPayload) => void;
  onInvalid: () => void;
};

/**
 * Shared "paste openchamber://connect" form used by the welcome connect screen
 * and Settings → Switch instance. Submitting redeems the pairing payload and
 * connects immediately — there is no separate save step.
 */
export const MobilePairingLinkForm: React.FC<MobilePairingLinkFormProps> = ({
  disabled = false,
  isBusy = false,
  tabIndex,
  inputClassName,
  buttonVariant = 'outline',
  buttonClassName = 'h-12 w-full',
  value,
  onValueChange,
  showPasteButton = false,
  error,
  onRedeem,
  onInvalid,
}) => {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState('');
  const [pasteError, setPasteError] = React.useState<string | null>(null);
  const [isPasting, setIsPasting] = React.useState(false);
  const pairingLink = value ?? draft;
  const errorId = React.useId();
  const updateLink = (next: string) => {
    setPasteError(null);
    setDraft(next);
    onValueChange?.(next);
  };

  const paste = useEvent(async () => {
    if (disabled || isBusy || isPasting) return;
    setIsPasting(true);
    try {
      const pasted = await navigator.clipboard.readText();
      updateLink(pasted);
      const payload = parseConnectionPayload(pasted);
      if (pasted.trim() && (!payload || !('pairing' in payload))) onInvalid();
    } catch {
      setPasteError(t('mobile.connect.link.pasteFallback'));
    } finally {
      setIsPasting(false);
    }
  });

  const handleSubmit = useEvent((event: React.FormEvent) => {
    event.preventDefault();
    if (disabled || isBusy || isPasting) return;
    const payload = parseConnectionPayload(pairingLink);
    if (!payload || !('pairing' in payload)) {
      onInvalid();
      return;
    }
    onRedeem(payload.pairing);
  });

  return (
    <form className="flex w-full flex-col gap-3" onSubmit={handleSubmit}>
      <div className="flex items-center gap-2">
        <Input
          {...mobileInputKeyboardProps}
          value={pairingLink}
          onChange={(event) => updateLink(event.target.value)}
          placeholder={t('mobile.connect.link.placeholder')}
          aria-label={t('mobile.connect.link.label')}
          inputMode="url"
          autoCapitalize="none"
          tabIndex={tabIndex}
          disabled={disabled || isBusy || isPasting}
          aria-invalid={Boolean(error)}
          aria-describedby={error || pasteError ? errorId : undefined}
          className={inputClassName}
        />
        {showPasteButton ? (
          <Button variant="outline" size="icon" onClick={() => void paste()} disabled={disabled || isBusy || isPasting} aria-label={t('mobile.connect.link.paste')}>
            <Icon name="clipboard" className="size-5" />
          </Button>
        ) : null}
      </div>
      {error || pasteError ? <p id={errorId} role="alert" className="typography-small text-[var(--status-error)]">{error || pasteError}</p> : null}
      <Button
        type="submit"
        variant={buttonVariant}
        size="lg"
        className={buttonClassName}
        disabled={disabled || isBusy || isPasting || !pairingLink.trim()}
      >
        {isBusy ? t('mobile.connect.connecting') : t('mobile.connect.connectButton')}
      </Button>
    </form>
  );
};

export const MobileConnectionMethodDivider: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-3 py-3" aria-hidden="true">
    <span className="h-px flex-1 bg-border/70" />
    <span className="typography-micro text-muted-foreground">{label}</span>
    <span className="h-px flex-1 bg-border/70" />
  </div>
);
