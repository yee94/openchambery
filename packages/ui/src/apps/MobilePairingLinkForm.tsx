import React from 'react';
import { useEvent } from '@reactuses/core';

import { Button } from '@/components/ui/button';
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
  onRedeem,
  onInvalid,
}) => {
  const { t } = useI18n();
  const [pairingLink, setPairingLink] = React.useState('');

  const handleSubmit = useEvent((event: React.FormEvent) => {
    event.preventDefault();
    const payload = parseConnectionPayload(pairingLink);
    if (!payload || !('pairing' in payload)) {
      onInvalid();
      return;
    }
    onRedeem(payload.pairing);
  });

  return (
    <form className="flex w-full flex-col gap-3" onSubmit={handleSubmit}>
      <input
        {...mobileInputKeyboardProps}
        value={pairingLink}
        onChange={(event) => setPairingLink(event.target.value)}
        placeholder={t('mobile.connect.link.placeholder')}
        aria-label={t('mobile.connect.link.label')}
        inputMode="url"
        autoCapitalize="none"
        tabIndex={tabIndex}
        disabled={disabled}
        className={inputClassName}
      />
      <Button
        type="submit"
        variant={buttonVariant}
        size="lg"
        className={buttonClassName}
        disabled={disabled || isBusy || !pairingLink.trim()}
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
