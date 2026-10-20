import { useState } from 'react';
import { SettingsRow } from '@/components/sections/shared/SettingsGroup';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { DictationTestDialog } from '@/components/dictation/DictationTestDialog';
import { useServerTTS } from '@/hooks/useServerTTS';
import { useVolcengineSpeechStore } from '@/stores/useVolcengineSpeechStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { VOLCENGINE_TTS_RESOURCES, VOLCENGINE_TTS_VOICES } from '@/lib/voice/volcengine-catalog';

const CUSTOM_ID = '$custom';
const ASR_RESOURCES = [
    { value: 'volc.seedasr.sauc.duration', label: 'Seed ASR 2.0 · duration' },
    { value: 'volc.seedasr.sauc.concurrent', label: 'Seed ASR 2.0 · concurrent' },
    { value: 'volc.bigasr.sauc.duration', label: 'Big ASR 1.0 · duration' },
    { value: 'volc.bigasr.sauc.concurrent', label: 'Big ASR 1.0 · concurrent' },
];

function SpeechIdSelect({ value, onChange, options, label, allowCustom = true }: {
    value: string; onChange: (value: string) => void;
    options: { value: string; label: string; description?: string }[]; label: string; allowCustom?: boolean;
}) {
    const { t } = useI18n();
    const [custom, setCustom] = useState(false);
    const known = options.some((option) => option.value === value);
    const customSelected = allowCustom && (custom || !known);
    return <div className="flex w-full min-w-0 flex-col items-end gap-2">
        <Select value={customSelected ? CUSTOM_ID : value} onValueChange={(next) => {
            setCustom(next === CUSTOM_ID);
            if (next !== CUSTOM_ID) onChange(next);
        }}>
            <SelectTrigger className="w-full min-w-0" aria-label={label}>
                <SelectValue>{(selected) => selected === CUSTOM_ID ? t('settings.voice.volcengine.custom') : options.find((option) => option.value === selected)?.label ?? selected}</SelectValue>
            </SelectTrigger>
            <SelectContent>
                {options.map((option) => <SelectItem key={option.value} value={option.value}>
                    <span className="flex min-w-0 flex-col">
                        <span>{option.label}</span>
                        <span className="break-all typography-meta text-muted-foreground">{option.description ?? option.value}</span>
                    </span>
                </SelectItem>)}
                {!allowCustom && !known && value && <SelectItem value={value}>{value}</SelectItem>}
                {allowCustom && <SelectItem value={CUSTOM_ID}>{t('settings.voice.volcengine.custom')}</SelectItem>}
            </SelectContent>
        </Select>
        {customSelected && <Input value={value} onChange={(event) => onChange(event.target.value)} aria-label={`${label} (${t('settings.voice.volcengine.custom')})`} />}
    </div>;
}

export function VolcengineSpeechSettings({ mode }: { mode: 'tts' | 'asr' }) {
    const { t } = useI18n();
    const apiKey = useVolcengineSpeechStore((state) => state.apiKey);
    const voice = useVolcengineSpeechStore((state) => state.voice);
    const resourceId = useVolcengineSpeechStore((state) => state.resourceId);
    const asrResourceId = useVolcengineSpeechStore((state) => state.asrResourceId);
    const { setApiKey, setVoice, setResourceId, setAsrResourceId } = useVolcengineSpeechStore.getState();
    const { speak, stop, isPlaying, error } = useServerTTS({ enabled: false });
    const [testOpen, setTestOpen] = useState(false);

    return (
        <>
            <SettingsRow itemId={`voice.volcengine-${mode}-key`} label={t('settings.voice.page.field.apiKey')} description={<>
                {t('settings.voice.volcengine.keyHelp')}{' '}
                <a href="https://console.volcengine.com/speech/new" target="_blank" rel="noreferrer" className="text-primary underline">{t('settings.voice.volcengine.openLink')}</a>
            </>}>
                <Input type="password" autoComplete="off" placeholder="API Key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} aria-label={t('settings.voice.page.field.apiKey')} />
            </SettingsRow>
            {mode === 'tts' && <>
            <SettingsRow itemId="voice.volcengine-resource" label={t('settings.voice.volcengine.resource')}>
                <SpeechIdSelect value={resourceId} onChange={setResourceId} options={VOLCENGINE_TTS_RESOURCES} label={t('settings.voice.volcengine.resource')} />
            </SettingsRow>
            <SettingsRow itemId="voice.volcengine-speaker" label={t('settings.voice.volcengine.speaker')}>
                <SpeechIdSelect key={resourceId} value={voice} onChange={setVoice} options={resourceId === 'seed-tts-2.0' ? VOLCENGINE_TTS_VOICES : []} label={t('settings.voice.volcengine.speaker')} />
            </SettingsRow>
            <SettingsRow label={t('settings.voice.page.actions.preview')}>
                <Button variant="outline" size="sm" disabled={!apiKey.trim() || !voice.trim() || !resourceId.trim()} onClick={() => {
                    if (isPlaying) stop();
                    else {
                        const { speechRate, speechPitch, speechVolume } = useConfigStore.getState();
                        void speak(t('settings.voice.page.preview.voiceLine', { voiceName: 'OpenChamber' }), { provider: 'volcengine', speed: speechRate, pitch: speechPitch, volume: speechVolume });
                    }
                }}>{isPlaying ? t('settings.voice.volcengine.stop') : t('settings.voice.page.actions.preview')}</Button>
                {error && <span role="alert" className="text-[var(--status-error)]">{error}</span>}
            </SettingsRow>
            </>}
            {mode === 'asr' && <>
            <SettingsRow itemId="voice.volcengine-asr-resource" label={t('settings.voice.volcengine.asrResource')}>
                <SpeechIdSelect value={asrResourceId} onChange={setAsrResourceId} options={ASR_RESOURCES.map((option) => ({
                    ...option,
                    description: t(option.value.endsWith('.duration') ? 'settings.voice.volcengine.durationHelp' : 'settings.voice.volcengine.concurrentHelp'),
                }))} label={t('settings.voice.volcengine.asrResource')} allowCustom={false} />
            </SettingsRow>
            <SettingsRow itemId="voice.volcengine-asr-test" label={t('settings.voice.volcengine.asrTest')} description={t('settings.voice.volcengine.testHelp')}>
                <Button variant="outline" size="sm" disabled={!apiKey.trim() || !asrResourceId.trim()} onClick={() => setTestOpen(true)}>{t('settings.voice.volcengine.asrTest')}</Button>
            </SettingsRow>
            {testOpen && <DictationTestDialog onClose={() => setTestOpen(false)} />}
            </>}
        </>
    );
}
