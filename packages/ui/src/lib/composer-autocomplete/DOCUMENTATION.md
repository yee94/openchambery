# Composer autocomplete engine

Runtime-agnostic trigger, rank, icon-name, and row-builder helpers for `/` commands, mid-line `/` skills, `#` snippets, and `@` mentions.

ChatInput and the Capacitor iOS native composer both consume this module. A later language-server consumer can import the same functions without mounting React autocomplete UI.

## Ownership

| Concern | Owner |
|---|---|
| Trigger detection (`/`, mid-line `/`, `#`, `@`, paste guard, shell off) | `trigger.ts` |
| Slash-command fuzzy rank | `slash-rank.ts` |
| Mid-line skill fuzzy rank | `skill-rank.ts` |
| Sprite icon names | `icons.ts` |
| Flat suggestion rows (titles, badges, icon names) | `rows.ts` |
| WebView PNG raster of a sprite icon | `rasterize-icon.ts` |
| Catalog fetch, Query, and insert/submit | Existing `CommandAutocomplete` / `SkillAutocomplete` / `FileMentionAutocomplete` |

Do not fetch files, commands, or skills from this folder. Ranking runs on catalogs the caller already loaded.

## Trigger priority

Matches ChatInput:

1. `inputMode === 'shell'` → closed
2. Document starts with `/`, caret still in the first token, no space → slash-command
3. Word-boundary `/` with no space in the token → slash-skill
4. Word-boundary `#` → snippet
5. Word-boundary `@` (`getFileMentionAutocompleteQuery`) → mention

Leading reserved icon slots (`/\u2003name`) are stripped before ranking.

## Native iOS

Capacitor iOS keeps the React catalogs mounted (hidden under `:root.oc-native-ios-composer`) so search stays on the JS channel. Those components emit `ComposerAutocompleteVisibleRows`. Shared UI rasterizes `iconName` to PNG and `OpenChamberComposer.update` paints a liquid-glass list above the card. Accept (tap or Return) calls the same insert/submit handlers as the web list.
