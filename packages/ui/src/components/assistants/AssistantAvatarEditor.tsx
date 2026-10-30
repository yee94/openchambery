import React from 'react';
import { useEvent } from '@reactuses/core';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import {
  AVATAR_PICKER_SHAPES, AVATAR_COLORS, assistantAvatarPigment,
  resolveAssistantAvatar, encodeAssistantAvatar, type AssistantAvatarRecipe,
} from '@/lib/assistant-avatar/recipe';

type Props = { seed: string; disabled: boolean; onChange: (seed: string) => void };

/** Selected-entity editor: previews stay in the existing Assistant draft until
 * Save succeeds. Search deliberately does not index entity-specific controls. */
export function AssistantAvatarEditor({ seed, disabled, onChange }: Props) {
  const { t } = useI18n();
  const recipe = resolveAssistantAvatar(seed);
  const change = useEvent((patch: Partial<AssistantAvatarRecipe>) => {
    onChange(encodeAssistantAvatar({ ...resolveAssistantAvatar(seed), ...patch }));
  });

  return (
    <div className="relative mx-auto w-full max-w-sm" data-assistant-avatar-editor="">
      <SettingsGroup ariaLabel={t('assistants.avatar.title')}>
        <SettingsRow className="yuri-settings-split-row-stacked" copyClassName="!hidden" controlClassName="!block !w-full !max-w-none px-3 py-6 sm:px-0 sm:py-3">
          <div className="absolute right-3 top-1 z-10 sm:right-2">
            <Button
              variant="ghost"
              size="xs"
              className="gap-1.5 text-xs font-normal text-muted-foreground/80 hover:text-muted-foreground sm:gap-1 sm:text-[10px]"
              disabled={disabled}
              aria-label={t('assistants.settings.randomAvatar')}
              title={t('assistants.settings.randomAvatar')}
              onClick={() => onChange(crypto.randomUUID())}
            >
              <Icon name="refresh" className="size-3.5 sm:size-2.5" />
              {t('assistants.settings.randomAvatar')}
            </Button>
          </div>
          <div className="flex flex-col gap-6 sm:gap-4">
          <div className="grid grid-cols-4 justify-items-center gap-3 sm:grid-cols-8 sm:gap-1" role="group" aria-label={t('assistants.avatar.shape')}>
            {AVATAR_PICKER_SHAPES.map((shape) => (
              <Button
                key={shape}
                variant="ghost"
                size="icon"
                className="size-11 rounded-lg ring-2 ring-transparent aria-pressed:ring-foreground/40 sm:size-9"
                disabled={disabled}
                aria-label={t(`assistants.avatar.shape.${shape}`)}
                title={t(`assistants.avatar.shape.${shape}`)}
                aria-pressed={recipe.shape === shape}
                data-avatar-shape-option={shape}
                onClick={() => change({ shape })}
              >
                <AgentAvatar kind="assistant" name={encodeAssistantAvatar({ ...recipe, shape })} size={32} />
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap justify-center gap-1" role="group" aria-label={t('assistants.avatar.color')}>
            {AVATAR_COLORS.map((color) => (
              <Button
                key={color}
                variant="ghost"
                size="icon"
                className="rounded-full [corner-shape:round] ring-2 ring-transparent aria-pressed:ring-foreground/50"
                disabled={disabled}
                aria-label={t(`assistants.avatar.color.${color}`)}
                title={t(`assistants.avatar.color.${color}`)}
                aria-pressed={recipe.color === color}
                data-avatar-color-option={color}
                onClick={() => change({ color })}
              >
                <span aria-hidden="true" className="size-5 rounded-full" style={{ backgroundColor: assistantAvatarPigment(color) }} />
              </Button>
            ))}
          </div>
          </div>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
