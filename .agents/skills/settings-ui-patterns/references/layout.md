# Settings Layout

The normative product contract lives at
`packages/ui/src/components/sections/shared/SETTINGS_DESIGN_SPEC.md`. Read it
before changing a Settings page.

## Visual Hierarchy

- Compose ordinary configuration from `SettingsGroup`, `SettingsField`, and
  `SettingsRow`.
- Use one quiet section label outside one grouped material card.
- Omit redundant headings when the field label already names a standalone
  setting.
- Keep controls compact and let the shared row own card chrome and dividers.
- Place checkbox/radio state before its label.
- Dim inactive option labels subtly; do not use transform jumps.

## Typography

Use the shared Settings tokens instead of assigning typography classes to
section headings:

- Secondary-page title: shared navigation/header component.
- Section label: `.yuri-settings-group-label` and
  `--yuri-settings-section-title-*`.
- Values/labels: `--yuri-settings-row-label-*` through `SettingsRow`.
- Helper/meta: `--yuri-settings-row-meta-*` through `SettingsRow` or the group
  description.
- Numeric values: add `tabular-nums` without changing the base size.

Never use `typography-ui-header` for a Settings section label.

## Spacing

- Use `yuri-settings-page-content` or `yuri-settings-section-stack` between sibling
  groups.
- Use `--yuri-settings-section-gap` between a section label and its card.
- Use `--yuri-settings-section-stack-gap` between cards.
- Let `SettingsRow` own row height, padding, divider, and card insets.
- Do not use local `mb-8`, `space-y-6`, `space-y-8`, or
  `px-2 pb-2 pt-0` section recipes.

## Alignment

For consistent desktop and mobile columns:

```tsx
<SettingsGroup label={t(sectionKey)}>
  <SettingsRow label={t(labelKey)} description={shortHelper}>
    {control}
  </SettingsRow>
</SettingsGroup>
```

- Let the shared responsive grid own narrow-layout collapse.
- Keep the complete control footprint, including adjacent actions, in the shared
  value column.
- Disable only the unavailable control; do not dim the entire label row by
  default.

## Responsive Grids

Use a one-column base when several independent groups form a desktop grid, but
retain the shared group primitive inside each grid cell:

```tsx
<div className="grid grid-cols-1 gap-2 md:grid-cols-[14rem_auto] md:gap-x-8" />
```

Template/entity editors may use a responsive grid because editing is their
primary task. Their surrounding group labels, inter-group spacing, helpers, and
theme tokens still follow the shared Settings specification.
