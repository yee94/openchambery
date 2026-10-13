import type { Event } from './types';
import { useSessionInboxOverlayStore } from './session-inbox-overlay';
import { normalizeSessionProjectionMessage } from './session-projection-api';
import { getTranscriptRepository, transcriptScope } from './transcript-repository-runtime';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { fetchExactSessionMessageRecord } from './transcript-parent-recovery';
import { enqueueExactFill } from './transcript-exact-fill-scheduler';
import { sessionBelongsToDirectory } from './session-location-authority';

/** Commit consumed input before retiring its composer presentation. */
export function handoffDeliveredInbox(directory: string, event: Event): void {
    if (event.type !== 'session.inbox.delivered') return;
    const props = event.properties as { sessionID?: string; inboxID?: string; eventCreated?: number };
    if (!props.sessionID || !props.inboxID) return;
    const repository = getTranscriptRepository();
    if (!repository) return;
    const scope = transcriptScope(directory, props.sessionID);
    if (repository.getParts(scope, props.inboxID).length > 0) return;
    const item = useSessionInboxOverlayStore.getState().list(props.sessionID).find(item => item.id === props.inboxID);
    const projected = item ? normalizeSessionProjectionMessage(props.sessionID, {
        id: item.id, type: 'user', text: item.payload.text, metadata: item.payload.metadata,
        time: { created: props.eventCreated ?? item.timeCreated },
        files: Array.isArray(item.payload.files) ? item.payload.files.flatMap(file => {
            if (!file || typeof file !== 'object' || typeof file.uri !== 'string') return [];
            return [{ name: file.name, source: { type: 'uri', uri: file.uri } }];
        }) : [],
    }) : null;
    if (!projected || projected.parts.length === 0) {
        const { sessionID, inboxID } = props;
        const transport = getRuntimeTransportIdentity();
        const generation = getRuntimeGeneration();
        const current = () => transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration()
            && repository === getTranscriptRepository() && sessionBelongsToDirectory(sessionID, directory);
        void enqueueExactFill(`${transport}\n${generation}\n${directory}\n${sessionID}\n${inboxID}`, async () => {
            if (!current()) return;
            const scoped = opencodeClient.getScopedSdkClient(directory);
            const row = await fetchExactSessionMessageRecord({ transport, generation, directory, sessionID, messageID: inboxID,
                request: async () => {
                    const raw = await scoped.session.message({ sessionID, messageID: inboxID });
                    const data = normalizeSessionProjectionMessage(sessionID, raw);
                    if (!data || data.info.id !== inboxID) throw new Error('Delivered inbox message unavailable');
                    return { data };
                },
            });
            if (!current()) return;
            repository.apply(scope, { type: 'materialize-snapshots', records: [row] });
        }).catch(() => {
            // Preserve all existing content; reconnect/authority recovery can retry.
            console.warn('[sync] Delivered inbox message recovery failed');
        });
        return;
    }
    repository.apply(scope, { type: 'sse-event-batch', events: [
        { type: 'message.updated', properties: { info: projected.info } } as Event,
        ...projected.parts.map(part => ({ type: 'message.part.updated', properties: { part } } as Event)),
    ] });
}
