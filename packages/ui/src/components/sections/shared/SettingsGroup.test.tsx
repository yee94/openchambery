import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SettingsField, SettingsGroup, SettingsRow } from './SettingsGroup';

describe('SettingsGroup', () => {
  test('renders one shared grouped card with responsive split rows', () => {
    const markup = renderToStaticMarkup(
      <SettingsGroup label="OpenCode" ariaLabel="OpenCode" description="Appears under the card">
        <SettingsRow label="Provider" description="Choose a provider" itemId="provider">
          <button type="button">Default</button>
        </SettingsRow>
      </SettingsGroup>,
    );

    expect(markup).toContain('class="oc-settings-group"');
    expect(markup).toContain('class="oc-settings-group-card"');
    expect(markup).toContain('oc-settings-group-row oc-settings-split-row');
    expect(markup).toContain('data-settings-label-script="latin"');
    expect(markup).toContain('data-settings-item="provider"');
    expect(markup).toContain('data-settings-value=""');
    expect(markup).toContain('oc-settings-group-description');
    expect(markup).toContain('Appears under the card');
  });

  test('does not opt CJK labels into Latin optical sizing', () => {
    const markup = renderToStaticMarkup(
      <SettingsGroup label="个性化">
        <SettingsRow label="外观">System</SettingsRow>
      </SettingsGroup>,
    );

    expect(markup).not.toContain('data-settings-label-script');
  });

  test('keeps a single field label and description inside its card', () => {
    const markup = renderToStaticMarkup(
      <SettingsField
        label="Sidebar brand"
        description="Shown in the desktop sidebar."
        itemId="appearance.sidebar-brand"
      >
        <input aria-label="Sidebar brand" />
      </SettingsField>,
    );

    const cardStart = markup.indexOf('oc-settings-group-card');
    expect(cardStart).toBeGreaterThan(-1);
    expect(markup.indexOf('Sidebar brand', cardStart)).toBeGreaterThan(cardStart);
    expect(markup.indexOf('Shown in the desktop sidebar.', cardStart)).toBeGreaterThan(cardStart);
    expect(markup).not.toContain('oc-settings-group-label');
  });

  test('places long single-field helper text below the card when requested', () => {
    const markup = renderToStaticMarkup(
      <SettingsField
        label="Sidebar brand"
        description="A longer explanation that belongs below the field surface."
        descriptionPlacement="outside"
      >
        <input aria-label="Sidebar brand" />
      </SettingsField>,
    );

    const cardEnd = markup.indexOf('</div><p class="oc-settings-group-description');
    expect(cardEnd).toBeGreaterThan(-1);
    expect(markup.indexOf('A longer explanation', cardEnd)).toBeGreaterThan(cardEnd);
  });
});
