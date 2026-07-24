# Settings Form Design Specification

This document is the visual and structural contract for every OpenChamber
Settings surface. It applies to desktop, hosted mobile, Capacitor mobile, VS
Code, and Electron. A feature must not create a second Settings recipe for one
runtime.

The reference implementation is `SettingsGroup.tsx`; the owning tokens and
responsive rules are in `styles/settings.css`. Scheduled-task detail uses the
same tokens through the grouped-card compatibility aliases.

## Required composition

Every ordinary setting uses one of these structures:

```tsx
<SettingsGroup label={t(sectionLabelKey)}>
  <SettingsRow
    itemId="page.setting"
    label={t(fieldLabelKey)}
    description={shortDescription}
  >
    {control}
  </SettingsRow>
</SettingsGroup>
```

```tsx
<SettingsField
  itemId="page.setting"
  label={t(fieldLabelKey)}
  description={longDescription}
  descriptionPlacement="outside"
>
  {control}
</SettingsField>
```

- `SettingsGroup` owns the section label and exactly one material card.
- `SettingsRow` owns label/value columns, row geometry, search anchors, and
  overflow behavior.
- `SettingsField` owns a standalone setting. It must not repeat the field name
  as a section heading.
- `SettingsToggleRow` is the required full-row Boolean pattern. It owns the
  checkbox-first layout plus pointer and keyboard activation without double
  toggling the nested checkbox.
- Rows must be direct children of the grouped card. A semantic `radiogroup`
  wrapper may contain standard rows when required for accessibility.
- Pages and nested collections use `oc-settings-page-content` or
  `oc-settings-section-stack`. They must not substitute local `space-y-*`,
  `mb-*`, or padding recipes for sibling Settings groups.

## Typography hierarchy

| Role | Token / owner | Mobile | Desktop |
|---|---|---:|---:|
| Secondary-page title | `MobileDetailNavigation` | shared navigation title | owning desktop pane |
| Section label outside a card | `--oc-settings-section-title-*` | 12px / 16px, normal | base UI label / form line-height, normal |
| Field label and value | `--oc-settings-row-label-*` | base UI label / form line-height | same |
| Helper or description | `--oc-settings-row-meta-*` | form helper size / line-height | same |

Page code must not apply `typography-ui-header` to a Settings section label.
It must not override the responsive section-label size or weight. Short helper
copy can remain under its field label. Copy that wraps to multiple lines goes
below the card through `descriptionPlacement="outside"`.

## Geometry and vertical rhythm

All measurements come from the Settings workspace tokens:

| Concern | Token | Current contract |
|---|---|---:|
| Card radius | `--oc-settings-group-radius` | 16px |
| Section label to card | `--oc-settings-section-gap` | 8px |
| Card to next card | `--oc-settings-section-stack-gap` | 20px |
| Row minimum height | `--oc-settings-row-min-height` | 52px |
| Row horizontal inset | `--oc-settings-row-inset` | 14px |
| Row vertical padding | `--oc-settings-row-block-padding` | 11px |
| Row divider | `--oc-settings-row-divider` | one semantic 1px divider |

The group card uses `--oc-settings-group-background`,
`--oc-settings-group-border`, and no shadow. Individual pages must not add a
different border, radius, shadow, row height, or group gap. Conditional rows do
not change the spacing before or after their group.

## Label, description, and value placement

- A section label is outside the card.
- A field label is inside the card, in the row's left column.
- A short description is smaller muted copy directly below that field label.
- A long or wrapping description is smaller muted copy below the card.
- Stable values occupy the right column and align to the right.
- Select, Input, NumberInput, and custom `oc-settings-inline-value` triggers
  reserve a transparent border at rest. Hover, popup-open, and focus reveal the
  border without changing geometry.
- The desktop value column, including adjacent reset actions, is capped by
  `--oc-settings-desktop-value-max-width`. Mobile uses the same semantic row
  and collapses through the shared responsive grid.
- Complex collections and editors that cannot fit in a compact value column
  add `oc-settings-split-row-stacked` to `SettingsRow`. On narrow/mobile
  surfaces the label occupies the first line and the complete control receives
  the full card width; the generic mobile two-column rule must not override
  this layout.

## Controls

- Boolean row: shared `SettingsToggleRow`. Use a bare shared `Checkbox` only
  when it is the right-column control of a true label/value `SettingsRow`.
- Mutually exclusive list: shared `Radio` rows.
- Short option set: shared `Button variant="chip" size="xs"` with
  `aria-pressed`.
- Numeric value: shared `NumberInput`.
- Text/path value: shared `Input`.
- Icon action: shared `Button size="icon"` plus sprite `Icon`.

Entity creation, credential entry, source editors, template editors, and
search fields may keep visibly bordered inputs because editing is their primary
task. Their surrounding section label, group spacing, typography, and helper
placement still follow this specification.

## Responsive and platform rules

- Desktop and mobile render the same Settings components. Do not branch into
  duplicate markup merely to change visual layout.
- Mobile secondary pages use `MobileDetailNavigation`; pages must not recreate
  the back button, title position, or trailing action.
- A Settings page whose desktop surface is a collection beside an entity
  editor is `kind: 'split'` in Settings metadata. It has one shared information
  architecture with two responsive presentations:
  - desktop: Settings navigation / entity collection / selected entity editor
    may remain visible side by side;
  - mobile: Settings home -> entity collection -> selected entity editor is a
    three-level navigation flow. Selecting or creating an entity advances one
    level; Back from the editor returns to the collection, and Back from the
    collection returns to Settings home.
- Split pages must use the `SettingsView` `nav`, `page-sidebar`, and
  `page-content` stages. Feature pages must not own a competing mobile detail
  flag, history entry, back button, or duplicated mobile-only editor.
- Split-page collections use `SettingsSidebarLayout` or the same
  `oc-settings-page-content` contract as their single scroll root. The mobile
  Settings shell owns the horizontal page gutter, so collection pages must not
  add a second mobile `px-*` layer. Summary controls and collection sections
  are `SettingsGroup` cards; the shared `MobileDetailNavigation` is the only
  secondary-page title, so collections do not repeat a local `h2`.
- A management page made of independent actions or dialogs is not a split page
  merely because it contains a list. Use `kind: 'single'` until an inline
  selected-entity editor actually exists.
- Settings may scroll as a page, but feature code must not pin a local title or
  search surface unless the owning navigation component explicitly requires it.
- A viewport-fixed secondary surface that escapes its parent page gutter must
  own exactly one `--oc-mobile-page-inline-inset` at its scrolling body
  boundary. Its header aligns to that token, and descendants must not add
  another page-level inset. Bottom actions use the shared
  `MobileFloatingBottomBar` rather than a page-specific full-width footer, so
  their glass material, screen-edge clearance, and safe-area behavior match the
  root mobile dock.
- Labels, controls, helper copy, borders, and gaps must remain identical across
  light, dark, and high-contrast themes by using semantic tokens.

## Forbidden legacy patterns

Do not introduce these inside a Settings detail page:

- `h3.typography-ui-header` as a section label;
- local `mb-8`, `space-y-6`, `space-y-8`, or `px-2 pb-2 pt-0` section recipes;
- page-specific card borders, radii, shadows, input widths, or row dividers;
- separate desktop/mobile copies of the same form row;
- a permanently outlined stable value when an inline Settings value is
  sufficient;
- helper text inheriting the field-label font size.

## Review checklist

1. Every ordinary section is a `SettingsGroup` or `SettingsField`.
2. Every stable label/value pair is a `SettingsRow`.
3. Section label, field label, and helper copy occupy three distinct token
   levels.
4. Long descriptions live outside the card.
5. Sibling cards use only the shared stack gap.
6. Rows have one consistent border/divider treatment.
7. Values are right-aligned and reveal borders without layout shift.
8. Search registry entries and `data-settings-item` anchors still agree.
9. Desktop and mobile use the same component tree.
10. Split pages traverse collection and editor as separate mobile levels, with
    browser/native Back returning exactly one level.
11. Focus, keyboard activation, long text, and conditional rows are verified.
