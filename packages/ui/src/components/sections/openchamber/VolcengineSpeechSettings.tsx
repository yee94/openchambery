import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useMutation } from '@tanstack/react-query';
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
import { getRuntimeGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { saveVolcengineSpeechSettings, useVolcengineSpeechQuery, type VolcengineSpeechPatch, type VolcengineSpeechSettings as SpeechSettings } from '@/queries/volcengineSpeechQueries';

const CUSTOM_ID = '$custom';
const ASR_RESOURCES = [
    { value: 'volc.seedasr.sauc.duration', label: 'Seed ASR 2.0 · duration' },
    { value: 'volc.seedasr.sauc.concurrent', label: 'Seed ASR 2.0 · concurrent' },
    { value: 'volc.bigasr.sauc.duration', label: 'Big ASR 1.0 · duration' },
    { value: 'volc.bigasr.sauc.concurrent', label: 'Big ASR 1.0 · concurrent' },
];

function SpeechIdSelect({ value, onChange, options, label, allowCustom = true, disabled = false }: {
    value: string; onChange: (value: string) => void;
    options: { value: string; label: string; description?: string }[]; label: string; allowCustom?: boolean; disabled?: boolean;
}) {
    const { t } = useI18n();
    const [custom, setCustom] = useState(false);
    const known = options.some((option) => option.value === value);
    const customSelected = allowCustom && (custom || !known);
    return <div className="flex w-full min-w-0 flex-col items-end gap-2">
        <Select disabled={disabled} value={customSelected ? CUSTOM_ID : value} onValueChange={(next) => {
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
        {customSelected && <Input disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} aria-label={`${label} (${t('settings.voice.volcengine.custom')})`} />}
    </div>;
}

export function VolcengineSpeechSettings({ mode, children }: { mode: 'tts' | 'asr'; children?: ReactNode }) {
    const generation = useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
    return <VolcengineSpeechSection key={`${generation}:${mode}`} mode={mode}>{children}</VolcengineSpeechSection>;
}

function VolcengineSpeechSection({ mode, children }: { mode: 'tts' | 'asr'; children?: ReactNode }) {
    const { t } = useI18n();
    const query = useVolcengineSpeechQuery();
    return <>
        {query.isError && <SettingsRow label={t('settings.voice.volcengine.loadFailed')}>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>{t('settings.voice.volcengine.retry')}</Button>
        </SettingsRow>}
        {!query.data && query.isPending && <SettingsRow label={t('common.loading')}>{null}</SettingsRow>}
        {query.data ? <VolcengineSpeechForm mode={mode} settings={query.data}>{children}</VolcengineSpeechForm> : children}
    </>;
}

function VolcengineSpeechForm({ mode, settings, children }: { mode: 'tts' | 'asr'; settings: SpeechSettings; children?: ReactNode }) {
    const { t } = useI18n();
    const active = useRef(true);
    useEffect(() => {
        active.current = true;
        return () => { active.current = false; };
    }, []);
    const [draft, setDraft] = useState<VolcengineSpeechPatch>(() => {
        const legacy = useVolcengineSpeechStore.getState();
        if (settings.configured || !legacy.apiKey) return {};
        return { apiKey: legacy.apiKey, voice: legacy.voice, resourceId: legacy.resourceId, asrResourceId: legacy.asrResourceId };
    });
    const saveMutation = useMutation({ mutationFn: saveVolcengineSpeechSettings, networkMode: 'always', retry: false, gcTime: 0 });
    const { voice, resourceId, asrResourceId } = { ...settings, ...draft };
    const dirty = Object.keys(draft).length > 0;
    const saving = saveMutation.isPending;
    const edit = (patch: VolcengineSpeechPatch) => {
        setDraft((previous) => ({ ...previous, ...patch }));
    };
    const save = async () => {
        const generation = getRuntimeGeneration();
        const legacyKey = useVolcengineSpeechStore.getState().apiKey;
        try {
            const confirmed = await saveMutation.mutateAsync(draft);
            if (!active.current) return null;
            if (draft.apiKey !== undefined && legacyKey === useVolcengineSpeechStore.getState().apiKey) {
                useVolcengineSpeechStore.getState().setApiKey('');
            }
            setDraft({});
            return confirmed;
        } catch {
            if (active.current && generation === getRuntimeGeneration()) toast.error(t('settings.voice.volcengine.saveFailed'));
            return null;
        }
    };
    const { speak, stop, isPlaying, error } = useServerTTS({ enabled: false });
    const [testOpen, setTestOpen] = useState(false);
    const test = async () => {
        if (mode === 'tts' && isPlaying) {
            stop();
            return;
        }
        if (saving) return;
        const confirmed = dirty ? await save() : settings;
        if (!confirmed || !active.current) return;
        if (!confirmed.configured) {
            toast.error(t('settings.providers.page.toast.apiKeyRequired'));
            return;
        }
        if (mode === 'asr') {
            setTestOpen(true);
        } else {
            const { speechRate, speechPitch, speechVolume } = useConfigStore.getState();
            void speak(t('settings.voice.page.preview.voiceLine', { voiceName: 'OpenChamber' }), { provider: 'volcengine', speed: speechRate, pitch: speechPitch, volume: speechVolume });
        }
    };

    return (
        <>
            <SettingsRow itemId={`voice.volcengine-${mode}-key`} label={t('settings.voice.page.field.apiKey')} description={<>
                {t('settings.voice.volcengine.keyHelp')}{' '}
                <a href="https://console.volcengine.com/speech/new" target="_blank" rel="noreferrer" className="text-primary underline">{t('settings.voice.volcengine.openLink')}</a>
            </>}>
                <Input type="password" autoComplete="off" disabled={saving} placeholder={settings.configured && draft.apiKey === undefined ? '••••••••' : 'API Key'} value={draft.apiKey ?? ''} onChange={(event) => edit({ apiKey: event.target.value })} aria-label={t('settings.voice.page.field.apiKey')} />
            </SettingsRow>
            {mode === 'tts' && <>
            <SettingsRow itemId="voice.volcengine-resource" label={t('settings.voice.volcengine.resource')}>
                <SpeechIdSelect value={resourceId} disabled={saving} onChange={(resourceId) => edit({ resourceId })} options={VOLCENGINE_TTS_RESOURCES} label={t('settings.voice.volcengine.resource')} />
            </SettingsRow>
            <SettingsRow itemId="voice.volcengine-speaker" label={t('settings.voice.volcengine.speaker')}>
                <SpeechIdSelect key={resourceId} value={voice} disabled={saving} onChange={(voice) => edit({ voice })} options={resourceId === 'seed-tts-2.0' ? VOLCENGINE_TTS_VOICES : []} label={t('settings.voice.volcengine.speaker')} />
            </SettingsRow>
            <SettingsRow label={t('settings.voice.page.actions.preview')}>
                <Button variant="outline" size="sm" disabled={!isPlaying && saving} aria-busy={saving} onClick={() => void test()}>{isPlaying ? t('settings.voice.volcengine.stop') : t('settings.voice.page.actions.preview')}</Button>
                {error && <span role="alert" className="text-[var(--status-error)]">{error}</span>}
            </SettingsRow>
            </>}
            {mode === 'asr' && <>
            <SettingsRow itemId="voice.volcengine-asr-resource" label={t('settings.voice.volcengine.asrResource')}>
                <SpeechIdSelect value={asrResourceId} disabled={saving} onChange={(asrResourceId) => edit({ asrResourceId })} options={ASR_RESOURCES.map((option) => ({
                    ...option,
                    description: t(option.value.endsWith('.duration') ? 'settings.voice.volcengine.durationHelp' : 'settings.voice.volcengine.concurrentHelp'),
                }))} label={t('settings.voice.volcengine.asrResource')} allowCustom={false} />
            </SettingsRow>
            <SettingsRow itemId="voice.volcengine-asr-test" label={t('settings.voice.volcengine.asrTest')} description={t('settings.voice.volcengine.testHelp')}>
                <Button variant="outline" size="sm" disabled={saving} aria-busy={saving} onClick={() => void test()}>{t('settings.voice.volcengine.asrTest')}</Button>
            </SettingsRow>
            {testOpen && <DictationTestDialog onClose={() => setTestOpen(false)} />}
            </>}
            {children}
            <div className="oc-settings-group-row flex justify-end">
                <Button size="sm" aria-busy={saving} onClick={() => { if (!saving) void save(); }}>
                    {t('settings.voice.volcengine.save')}
                </Button>
            </div>
        </>
    );
}
