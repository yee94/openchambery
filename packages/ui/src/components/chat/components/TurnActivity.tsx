import React from 'react';

import ProgressiveGroup from '../message/parts/ProgressiveGroup';
import type { TurnActivityPresentationKind, TurnActivityRecord, TurnCompletionDisposition } from '../lib/turns/types';
import type { ToolPopupContent } from '../message/types';
import type { StreamPhase } from '../message/types';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';

interface DiffStats {
    additions: number;
    deletions: number;
    files: number;
}

interface TurnActivityProps {
    parts: TurnActivityRecord[];
    isExpanded: boolean;
    collapsedPreviewCount?: number;
    completionDisposition?: TurnCompletionDisposition;
    activityPresentationKind?: TurnActivityPresentationKind;
    durationMs?: number;
    startedAt?: number;
    onToggle: () => void;
    isMobile: boolean;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    streamPhase: StreamPhase;
    showHeader: boolean;
    statusOnly?: boolean;
    animateRows?: boolean;
    animatedToolIds?: Set<string>;
    diffStats?: DiffStats;
    renderJustificationActions?: (activity: TurnActivityRecord) => React.ReactNode;
}

const TurnActivity: React.FC<TurnActivityProps> = (props) => {
    return <ProgressiveGroup {...props} />;
};

export default React.memo(TurnActivity);
