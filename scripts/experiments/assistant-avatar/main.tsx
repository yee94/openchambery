import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { AvatarLab } from './AvatarLab';
import '@/index.css';

useI18nStore.getState().setLocale('zh-CN', false);
createRoot(document.getElementById('root')!).render(<I18nProvider><AvatarLab /></I18nProvider>);
