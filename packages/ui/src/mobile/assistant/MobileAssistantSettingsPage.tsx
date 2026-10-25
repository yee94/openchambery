import { useState } from 'react';
import { AssistantsSettingsPage } from '@/components/sections/assistants/AssistantsSettingsPage';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useI18n } from '@/lib/i18n';
import { MobileDetailNavigation } from '../MobileDetailNavigation';
import { MobileFloatingSurface } from '../MobileSurface';

/** A phone-stack detail; selection and Back belong to the owning route. */
export function MobileAssistantSettingsPage({ assistantID, onBack }: {
  assistantID: string;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [saveActionContainer, setSaveActionContainer] = useState<HTMLDivElement | null>(null);
  return (
    <div data-settings-view="true" data-mobile-settings-stage="page-content" className="yuri-settings-workspace yuri-settings-workspace-mobile flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <MobileDetailNavigation
        title={t('assistants.title')}
        backAriaLabel={t('settings.view.actions.back')}
        onBack={onBack}
        trailing={<div ref={setSaveActionContainer} />}
      />
      <div className="min-h-0 flex-1 overflow-hidden px-[var(--yuri-mobile-page-inline-inset)] pb-[var(--yuri-safe-area-bottom,env(safe-area-inset-bottom,0px))]">
        <MobileFloatingSurface className="yuri-mobile-settings-detail-card h-full">
          <ErrorBoundary>
            <AssistantsSettingsPage key={assistantID} assistantID={assistantID} onItemDeleted={onBack} saveActionContainer={saveActionContainer} />
          </ErrorBoundary>
        </MobileFloatingSurface>
      </div>
    </div>
  );
}
