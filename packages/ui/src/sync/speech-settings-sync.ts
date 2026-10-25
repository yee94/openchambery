import { QueryObserver, type QueryObserverResult } from '@tanstack/react-query';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { queryClient } from '@/lib/queryRuntime';
import { subscribeYuriEvents } from '@/lib/yuriEvents';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { speechDefaults, type SpeechSettings } from '@/lib/voice/speechSettings';
import { speechSettingsQueryOptions } from '@/queries/speechSettingsQueries';
import { useConfigStore } from '@/stores/useConfigStore';

export function mountSpeechSettingsSync(): () => void {
    if (getRegisteredRuntimeAPIs()?.runtime.isVSCode) return () => {};
    const observer = new QueryObserver(queryClient, speechSettingsQueryOptions());
    const unsubscribeEvents = subscribeYuriEvents((event) => {
        if (event.type === 'speech-settings-changed' || event.type === 'event-stream-ready') {
            void queryClient.invalidateQueries({ queryKey: speechSettingsQueryOptions().queryKey, exact: true });
        }
    });
    const apply = (result: QueryObserverResult<SpeechSettings>) => {
        if (!result.data || observer.options.queryKey[0] !== getRuntimeTransportIdentity()) return;
        const previous = useConfigStore.getState();
        if (Object.entries(result.data).some(([key, value]) => previous[key as keyof typeof previous] !== value)) {
            useConfigStore.setState(result.data);
        }
    };
    const unsubscribeQuery = observer.subscribe(apply);
    apply(observer.getCurrentResult());
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
        useConfigStore.setState(speechDefaults);
        observer.setOptions(speechSettingsQueryOptions());
        apply(observer.getCurrentResult());
    });
    return () => {
        unsubscribeRuntime();
        unsubscribeQuery();
        unsubscribeEvents();
        observer.destroy();
    };
}
