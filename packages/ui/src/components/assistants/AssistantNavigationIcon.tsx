import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useAssistantNavigationAvatar } from './useAssistantNavigationAvatar';
import { ProceduralAssistantAvatar } from './ProceduralAssistantAvatar';

export const AssistantNavigationIcon = React.memo(function AssistantNavigationIcon({ className, size = 16 }: { className: string; size?: number }) {
  const avatar = useAssistantNavigationAvatar();
  return avatar
    ? <span aria-hidden="true" data-assistant-navigation-avatar="" className={`${className} inline-flex`}><ProceduralAssistantAvatar seed={avatar} size={size} motion="idle" randomizeShape /></span>
    : <Icon name="ai-agent" className={className} />;
});
