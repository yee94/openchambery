import { useStore } from 'zustand';
import { useDirectoryStore, useSessionMessages } from '@/sync/sync-context';
import { useSessionSurface } from '../SessionSurfaceContext';
import type { AssistantErrorPresentation } from './assistantErrorPresentation';
import { ResponseStatusRow } from './ResponseStatusRow';

type Props = {
    presentation: AssistantErrorPresentation;
    sessionId?: string;
    messageId: string;
    directory?: string;
};

function LiveAssistantResponseStatus({ presentation, sessionId, messageId, directory }: Props & { sessionId: string; directory?: string }) {
    const store = useDirectoryStore(directory, { bootstrap: false });
    const recovering = useStore(store, (state) => Boolean(state.session_execution_recovery[sessionId]));
    const retrying = useStore(store, (state) => state.session_status[sessionId]?.type === 'retry');
    const messages = useSessionMessages(sessionId, directory);
    if (!recovering && !retrying) return <ResponseStatusRow presentation={presentation} />;
    let latestAssistantId: string | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === 'assistant') {
            latestAssistantId = messages[index].id;
            break;
        }
    }
    // Only the current attempt is superseded by live recovery/retry feedback.
    // Historical failures and explicit user stops retain their own meaning.
    if (latestAssistantId === messageId && (
        retrying || (recovering && presentation.detail === 'aborted' && presentation.icon === 'pause-circle')
    )) return null;
    return <ResponseStatusRow presentation={presentation} />;
}

export function AssistantResponseStatus(props: Props) {
    const surface = useSessionSurface();
    if (!props.sessionId || !surface.active || !surface.capabilities.compose) {
        return <ResponseStatusRow presentation={props.presentation} />;
    }
    return <LiveAssistantResponseStatus {...props} sessionId={props.sessionId} directory={surface.directory ?? props.directory} />;
}
