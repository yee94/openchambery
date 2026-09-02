import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const settingsSource = readFileSync(join(directory, 'OpenChamberVisualSettings.tsx'), 'utf8');
const searchSource = readFileSync(join(directory, '../../../lib/settings/search.ts'), 'utf8');
const messagesDirectory = join(directory, '../../../lib/i18n/messages');
const localeFiles = ['en.settings.ts', 'es.settings.ts', 'fr.settings.ts', 'ja.settings.ts', 'ko.settings.ts', 'pl.settings.ts', 'pt-BR.settings.ts', 'uk.settings.ts', 'zh-CN.settings.ts', 'zh-TW.settings.ts'];

describe('iOS native UI appearance setting', () => {
  test('registers the matching settings search anchor and localizes all copy', () => {
    expect(settingsSource).toContain('itemId="appearance.ios-native-ui"');
    expect(settingsSource).toContain('canShowIosNativeUiSetting');
    expect(searchSource).toContain("id: 'appearance.ios-native-ui'");
    expect(searchSource).toContain("titleKey: 'settings.openchamber.visual.field.iosNativeUi'");
    expect(searchSource).toContain("descriptionKey: 'settings.openchamber.visual.field.iosNativeUiHint'");

    for (const fileName of localeFiles) {
      const dictionary = readFileSync(join(messagesDirectory, fileName), 'utf8');
      expect(dictionary).toContain('settings.openchamber.visual.field.iosNativeUi');
      expect(dictionary).toContain('settings.openchamber.visual.field.iosNativeUiHint');
    }
  });
});

describe('local transcript cache settings', () => {
  test('uses a destructive confirmation flow with a disabled loading state', () => {
    expect(settingsSource).toContain('itemId="appearance.transcript-cache"');
    expect(settingsSource).toContain('variant="destructive"');
    expect(settingsSource).toContain('open={clearTranscriptCacheDialogOpen}');
    expect(settingsSource).toContain('disabled={clearingTranscriptCache}');
    expect(settingsSource).toContain('aria-busy={clearingTranscriptCache || undefined}');
    expect(settingsSource).toContain("t('settings.openchamber.visual.transcriptCache.dialog.clearing')");
  });

  test('reports API success and failure while preserving the confirmation on failure', () => {
    expect(settingsSource).toContain('await clearCurrentRuntimeTranscriptCache();');
    expect(settingsSource).toContain('setClearTranscriptCacheDialogOpen(false);');
    expect(settingsSource).toContain("toast.success(t('settings.openchamber.visual.transcriptCache.toast.cleared'))");
    expect(settingsSource).toContain("toast.error(t('settings.openchamber.visual.transcriptCache.toast.failed'))");
    expect(settingsSource.indexOf('setClearTranscriptCacheDialogOpen(false);')).toBeLessThan(settingsSource.indexOf("toast.success(t('settings.openchamber.visual.transcriptCache.toast.cleared'))"));
  });

  test('registers the matching settings search anchor and localizes all copy', () => {
    expect(searchSource).toContain("id: 'appearance.transcript-cache'");
    expect(searchSource).toContain("titleKey: 'settings.openchamber.visual.transcriptCache.label'");
    expect(searchSource).toContain("descriptionKey: 'settings.openchamber.visual.transcriptCache.description'");
    expect(settingsSource).toContain('itemId="appearance.transcript-cache"');

    for (const fileName of localeFiles) {
      const dictionary = readFileSync(join(messagesDirectory, fileName), 'utf8');
      expect(dictionary).toContain('settings.openchamber.visual.transcriptCache.label');
      expect(dictionary).toContain('settings.openchamber.visual.transcriptCache.description');
      expect(dictionary).toContain('settings.openchamber.visual.transcriptCache.action');
      expect(dictionary).toContain('settings.openchamber.visual.transcriptCache.dialog.title');
      expect(dictionary).toContain('settings.openchamber.visual.transcriptCache.dialog.description');
      expect(dictionary).toContain('settings.openchamber.visual.transcriptCache.dialog.clearing');
      expect(dictionary).toContain('settings.openchamber.visual.transcriptCache.toast.cleared');
      expect(dictionary).toContain('settings.openchamber.visual.transcriptCache.toast.failed');
    }
  });
});
