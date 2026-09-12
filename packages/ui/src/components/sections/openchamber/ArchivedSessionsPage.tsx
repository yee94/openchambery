import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { ArchivedSessionsManager } from './ArchivedSessionsDialog';

export const ArchivedSessionsPage: React.FC = () => {
  return (
    <SettingsPageLayout>
      <ArchivedSessionsManager mode="page" />
    </SettingsPageLayout>
  );
};
