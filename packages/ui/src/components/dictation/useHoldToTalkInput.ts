import { useState } from 'react';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { useConfigStore } from '@/stores/useConfigStore';

export type HoldToTalkHint = 'recording' | 'cancelling' | 'editing' | 'processing' | null;

/** Shared state only; each input owns its copy and draft/send behavior. */
export function useHoldToTalkInput({ available }: { available: boolean }) {
    const globallyEnabled = useConfigStore((state) => state.dictationEnabled);
    const [currentHint, onHintChange] = useState<HoldToTalkHint>(null);
    const enabled = available && globallyEnabled && !isVSCodeRuntime() && isDictationCaptureSupported();
    const hint = enabled ? currentHint : null;
    return { globallyEnabled, enabled, hint, onHintChange };
}
