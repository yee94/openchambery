import React from 'react';
import type { Agent } from '@opencode-ai/sdk/v2';
import { cn } from '@/lib/utils';
import { getAgentDisplayName } from './mobileControlsUtils';
import { AgentCycleLabel } from '@/components/chat/AgentCycleLabel';
import { useAgentCycleLabelReveal } from '@/components/chat/useAgentCycleLabelReveal';
import { getAgentColor } from '@/lib/agentColors';
import { COMPOSER_ICON_HOVER_CLASS } from '@/components/chat/message/parts/toolRowChrome';

interface MobileAgentButtonProps {
    onCycleAgent: () => void;
    onOpenAgentPanel: () => void;
    className?: string;
    agentName?: string | null;
    agents?: Agent[];
    disabled?: boolean;
}

const LONG_PRESS_MS = 500;

// NOTE: Use pointer events instead of onClick to keep soft keyboard open on mobile
export const MobileAgentButton: React.FC<MobileAgentButtonProps> = ({ onCycleAgent, onOpenAgentPanel, className, agentName, agents = [], disabled = false }) => {
    const normalizedAgentName = agentName ?? undefined;
    const agentLabel = getAgentDisplayName(agents, normalizedAgentName);
    const showAgentCycleLabel = useAgentCycleLabelReveal(normalizedAgentName);
    const agentColor = getAgentColor(normalizedAgentName);

    const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const isLongPressRef = React.useRef(false);

    const handlePointerDown = (event: React.PointerEvent) => {
        // Same pattern as PermissionAutoAcceptButton: block the focus transfer
        // iOS performs on touch so cycling the agent keeps the keyboard open.
        if (event.pointerType === 'touch') {
            event.preventDefault();
        }
        if (disabled) return;
        isLongPressRef.current = false;
        longPressTimerRef.current = setTimeout(() => {
            isLongPressRef.current = true;
            onOpenAgentPanel();
        }, LONG_PRESS_MS);
    };

    // Use onPointerUp (not onClick) to prevent focus transfer that closes mobile keyboard
    const handlePointerUp = () => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
        if (!disabled && !isLongPressRef.current) {
            onCycleAgent();
        }
    };

    const handlePointerLeave = () => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    };

    React.useEffect(() => {
        return () => {
            if (longPressTimerRef.current) {
                clearTimeout(longPressTimerRef.current);
            }
        };
    }, []);

    return (
        <button
            type="button"
            disabled={disabled}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp} // Don't use onClick - it closes mobile keyboard
            onPointerLeave={handlePointerLeave}
            onContextMenu={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            className={cn(
                'inline-flex flex-shrink-0 items-center select-none focus:outline-none touch-none disabled:cursor-not-allowed disabled:opacity-40',
                COMPOSER_ICON_HOVER_CLASS,
                className
            )}
            title={agentLabel}
            aria-label={agentLabel}
        >
            <AgentCycleLabel
                name={normalizedAgentName}
                label={agentLabel}
                revealed={showAgentCycleLabel}
                avatarSize={16}
                slotClassName="h-6 w-6"
                colorVar={agentColor.var}
            />
        </button>
    );
};
