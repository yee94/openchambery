import React from 'react';
import { useEvent, useLocalStorage } from '@reactuses/core';
import { useI18n } from '@/lib/i18n';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { getDefaultTheme } from '@/lib/theme/themes';
import { generatedAvatarDataUri } from '@/lib/generatedAvatar';
import { AVATAR_PICKER_SHAPES, createDefaultAssistantAvatarSeed, encodeAssistantAvatar, resolveAssistantAvatar } from '@/lib/assistant-avatar/recipe';
import { rasterizePngBase64 } from '@/lib/rasterizePng';
import { AssistantAvatarEditor } from '@/components/assistants/AssistantAvatarEditor';
import { AssistantWorkingAvatar } from '@/components/assistants/AssistantWorkingAvatar';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { SettingsActionHeader } from '@/components/sections/shared/SettingsActionHeader';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import { Button } from '@/components/ui/button';

// The lab imports production components, but never connects to a runtime or
// writes real Assistant settings. Its save key is confined to this origin.
export function AvatarLab() {
  const { t, locale, setLocale, label } = useI18n();
  const [saved, setSaved] = useLocalStorage('yuri:avatar-lab:seed:v1', createDefaultAssistantAvatarSeed('lab-default'));
  const [seed, setSeed] = React.useState(saved ?? createDefaultAssistantAvatarSeed('lab-default'));
  const [dark, setDark] = React.useState(true);
  const [working, setWorking] = React.useState(false);
  const [png, setPng] = React.useState<string | null>(null);
  const stress = new URLSearchParams(location.search).has('stress');
  const mixedShapes = new URLSearchParams(location.search).has('shapes');
  React.useLayoutEffect(() => {
    const themeStyle = document.createElement('style');
    themeStyle.textContent = `:root { ${new CSSVariableGenerator().generate(getDefaultTheme(dark))} }`;
    document.head.append(themeStyle);
    document.documentElement.classList.toggle('dark', dark);
    return () => themeStyle.remove();
  }, [dark]);
  const save = useEvent(async () => {
    setSaved(seed);
    const raster = await rasterizePngBase64(generatedAvatarDataUri('assistant', seed), 128);
    setPng(raster ? `data:image/png;base64,${raster}` : null);
  });

  return (
    <main className="yuri-settings-workspace yuri-settings-page-content mx-auto w-full max-w-3xl p-4 sm:p-8" data-avatar-lab="">
      <SettingsActionHeader actions={<>
        <Button size="sm" variant="ghost" onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}>{label(locale === 'zh-CN' ? 'en' : 'zh-CN')}</Button>
        <Button size="sm" variant="ghost" onClick={() => setDark(!dark)}>{t(dark ? 'settings.yuri.visual.option.themeMode.light' : 'settings.yuri.visual.option.themeMode.dark')}</Button>
        <Button size="sm" onClick={save}>{t('assistants.settings.save')}</Button>
      </>}>
        <span className="typography-ui-header">Yuri / {t('assistants.avatar.title')}</span>
      </SettingsActionHeader>
      <AssistantAvatarEditor seed={seed} disabled={false} onChange={setSeed} />
      <SettingsGroup label={t('assistants.title')} actions={<>
        <Button variant="chip" size="xs" aria-pressed={working} onClick={() => setWorking(!working)}>{t('assistants.avatar.motion.thinking')}</Button>
        <Button size="sm" onClick={() => setSeed(crypto.randomUUID())}>{t('assistants.settings.randomAvatar')}</Button>
      </>}>
        {Array.from({ length: stress ? 20 : 3 }, (_, index) => {
          const defaultSeed = createDefaultAssistantAvatarSeed(`lab-${index}`);
          const avatarSeed = index === 0 ? seed : mixedShapes ? encodeAssistantAvatar({
            ...resolveAssistantAvatar(defaultSeed), shape: AVATAR_PICKER_SHAPES[index % AVATAR_PICKER_SHAPES.length],
          }) : defaultSeed;
          return (
            <SettingsRow key={index} label={index === 0 ? 'Yuri' : `Yuri ${index + 1}`}>
              <AssistantWorkingAvatar name={`lab-${index}`} avatarSeed={avatarSeed} size={44} working={working} label={`Yuri ${index + 1}`} />
            </SettingsRow>
          );
        })}
      </SettingsGroup>
      <SettingsGroup label={t('assistants.settings.defaultShare')}>
        <SettingsRow label={t('assistants.avatar.preview')}>
          <div className="flex items-center justify-end gap-3">
            <AgentAvatar kind="assistant" name={saved ?? createDefaultAssistantAvatarSeed('lab-default')} size={44} />
            {png ? <img src={png} alt={t('assistants.avatar.preview')} width={44} height={44} data-native-png="" /> : null}
          </div>
        </SettingsRow>
      </SettingsGroup>
      <code className="block break-all typography-micro text-muted-foreground" data-saved-avatar="">{saved}</code>
    </main>
  );
}
