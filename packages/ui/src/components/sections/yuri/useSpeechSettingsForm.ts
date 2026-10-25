import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { saveSpeechSettings } from '@/queries/speechSettingsQueries';
import type { SpeechSettings, SpeechSettingsPatch } from '@/lib/voice/speechSettings';

export function useSpeechSettingsForm(settings: SpeechSettings) {
    const { t } = useI18n();
    const [draft, setDraft] = useState<SpeechSettingsPatch>({});
    const active = useRef(true);
    useEffect(() => {
        active.current = true;
        return () => { active.current = false; };
    }, []);
    const mutation = useMutation({
        mutationFn: ({ patch, generation, transport }: { patch: SpeechSettingsPatch; generation: number; transport: string }) => saveSpeechSettings(patch, generation, transport),
        networkMode: 'always', retry: false, gcTime: 0,
    });
    const save = async () => {
        if (mutation.isPending) return null;
        const generation = getRuntimeGeneration();
        const submitted = draft;
        try {
            const saved = await mutation.mutateAsync({ patch: draft, generation, transport: getRuntimeTransportIdentity() });
            if (!active.current || generation !== getRuntimeGeneration()) return null;
            setDraft((current) => current === submitted ? {} : Object.fromEntries(
                Object.entries(current).filter(([key, value]) => !Object.is(value, submitted[key as keyof SpeechSettingsPatch])),
            ));
            return saved;
        } catch {
            if (active.current && generation === getRuntimeGeneration()) toast.error(t('settings.voice.volcengine.saveFailed'));
            return null;
        } finally {
            mutation.reset();
        }
    };
    return {
        values: { ...settings, ...draft },
        draft,
        saving: mutation.isPending,
        edit: (patch: SpeechSettingsPatch) => setDraft((previous) => ({ ...previous, ...patch })),
        save,
    };
}
