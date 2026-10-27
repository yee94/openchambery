import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useAssistantNavigationAvatar } from './useAssistantNavigationAvatar';

export const AssistantNavigationIcon = React.memo(function AssistantNavigationIcon({ className }: { className: string }) {
  const avatar = useAssistantNavigationAvatar();
  return avatar
    ? <img src={avatar} alt="" aria-hidden="true" draggable={false} data-assistant-navigation-avatar="" className={`${className} rounded-[25%] object-contain`} />
    : <Icon name="ai-agent" className={className} />;
});
