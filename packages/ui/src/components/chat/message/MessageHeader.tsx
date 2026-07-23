import React from 'react';
import { cn } from '@/lib/utils';
import { getAgentColor } from '@/lib/agentColors';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { formatEffortLabel } from '@/components/chat/mobileControlsUtils';
import { Icon } from "@/components/icon/Icon";
import { ModelLogo } from '@/components/ui/ModelLogo';

interface MessageHeaderProps {
    isUser: boolean;
    isMobile: boolean;
    providerID: string | null;
    /** 模型 ID：优先按模型名匹配品牌图标，聚合 Provider 不再误显示渠道 logo */
    modelID?: string | null;
    agentName: string | undefined;
    modelName: string | undefined;
    variant?: string;
}

/** Non-default thinking depth only — matches composer model-label suffix rules. */
const resolveVariantSuffix = (variant?: string) => {
    if (!variant?.trim()) return null;
    const trimmed = variant.trim();
    if (trimmed.toLowerCase() === 'default') return null;
    return formatEffortLabel(trimmed);
};

const MessageHeader: React.FC<MessageHeaderProps> = ({ isUser, isMobile, providerID, modelID, agentName, modelName, variant }) => {
    const variantSuffix = !isUser ? resolveVariantSuffix(variant) : null;
    const displayModelName = modelName || 'Assistant';

    return (
        <div className={cn('mb-1.5')}>
            <div className={cn('flex items-center justify-between gap-2')}>
                <div className="flex items-center gap-2">
                    <div className="flex-shrink-0">
                        {isUser ? (
                            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                                <Icon name="user-3" className="h-4 w-4 text-primary" />
                            </div>
                        ) : (
                            <div className="flex items-center justify-center">
                                <ModelLogo
                                    modelId={modelID}
                                    providerId={providerID}
                                    className="h-4 w-4"
                                    fallback={(
                                        <Icon name="brain-ai-3" className="h-4 w-4"
                                            style={{ color: `var(${getAgentColor(agentName).var})` }}/>
                                    )}
                                />
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <h3
                            className={cn(
                                'inline-flex min-w-0 items-center gap-1.5 font-semibold typography-ui-header tracking-tight leading-none',
                                isUser ? 'text-primary' : 'text-foreground'
                            )}
                        >
                            <span className="truncate">{isUser ? 'You' : displayModelName}</span>
                            {variantSuffix ? (
                                <span className="shrink-0 font-normal text-muted-foreground">
                                    {variantSuffix}
                                </span>
                            ) : null}
                        </h3>
                        {!isUser && agentName && (
                            <div
                                className={cn(
                                    'flex items-center gap-1 px-1.5 py-0 rounded cursor-default',
                                    'agent-badge',
                                    isMobile ? 'text-[12px]' : 'typography-meta',
                                    'hover:bg-[rgb(from_var(--agent-color-bg)_r_g_b_/_0.1)] hover:border-[rgb(from_var(--agent-color)_r_g_b_/_0.2)]',
                                    getAgentColor(agentName).class
                                )}
                            >
                                {/* 与选择 Agent 一致：用 identicon 头像代替通用机器人图标 */}
                                <AgentAvatar name={agentName} size={12} />
                                <span className="font-medium">
                                    {agentName.charAt(0).toUpperCase() + agentName.slice(1)}
                                </span>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default React.memo(MessageHeader);
