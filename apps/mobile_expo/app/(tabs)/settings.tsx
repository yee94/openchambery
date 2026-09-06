import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo } from 'react';

import { SettingsHome } from '@/components/settings/SettingsHome';
import { SettingsPageHost } from '@/components/settings/SettingsPageHost';
import { resolveExpoSettingsSlug } from '@/lib/settings/metadata';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Settings home + MOBILE_SETTINGS_PAGE_SLUGS (minus Voice).
 * Track 5 Assistant routes edit/create via slug=assistants (+ assistantId / create).
 */
export default function SettingsTab() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    slug?: string | string[];
    assistantId?: string | string[];
    create?: string | string[];
  }>();
  const slugParam = first(params.slug);
  const assistantId = first(params.assistantId);
  const create = first(params.create) === '1';
  const resolved = useMemo(() => resolveExpoSettingsSlug(slugParam), [slugParam]);

  if (resolved !== 'home') {
    return (
      <SettingsPageHost
        slug={resolved}
        assistantId={assistantId}
        create={create}
        onBack={() =>
          router.replace({
            pathname: '/(tabs)/settings',
            params: {},
          })
        }
      />
    );
  }

  return <SettingsHome />;
}
