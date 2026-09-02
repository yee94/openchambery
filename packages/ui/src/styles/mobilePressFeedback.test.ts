import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mobileCss = readFileSync(join(__dirname, 'mobile.css'), 'utf-8');
const buttonSource = readFileSync(join(__dirname, '../components/ui/button.tsx'), 'utf-8');
const dropdownStylesSource = readFileSync(join(__dirname, '../components/ui/dropdown-menu.styles.ts'), 'utf-8');
const contextMenuSource = readFileSync(join(__dirname, '../components/ui/context-menu.tsx'), 'utf-8');
const tabBarSource = readFileSync(join(__dirname, '../mobile/MobileTabBar.tsx'), 'utf-8');
const rowActionsSource = readFileSync(join(__dirname, '../mobile/projects/MobileRowActionsSheet.tsx'), 'utf-8');
const projectCardSource = readFileSync(join(__dirname, '../mobile/projects/MobileProjectCard.tsx'), 'utf-8');
const assistantCardSource = readFileSync(join(__dirname, '../mobile/assistant/MobileAssistantTab.tsx'), 'utf-8');
const assistantViewSource = readFileSync(join(__dirname, '../components/assistants/AssistantView.tsx'), 'utf-8');
const scheduledTasksSource = readFileSync(join(__dirname, '../components/session/ScheduledTasksDialog.tsx'), 'utf-8');
const scheduledEditorSource = readFileSync(join(__dirname, '../components/session/ScheduledTaskEditorDialog.tsx'), 'utf-8');

describe('mobile press feedback scale policy', () => {
  test('default and compact press scales grow with restrained bounds', () => {
    expect(mobileCss).toContain('--oc-press-soft-scale');
    expect(mobileCss).toContain('--oc-press-compact-scale: 1.05');
    expect(mobileCss).toContain('--oc-press-edge-outset: 3px');
    expect(mobileCss).toContain('calc(1 + (2 * var(--oc-press-edge-outset)) / 100cqi)');
    expect(mobileCss).toContain('1.006,');
    expect(mobileCss).toContain('1.03');
    expect(mobileCss).toContain('[data-mobile-press-feedback="compact"]');
    expect(mobileCss).toContain(
      ':not(\n      [data-mobile-press-feedback="compact"]\n    ):not(\n      [data-mobile-press-surface-trigger]\n    ):active:not(:has(:where(button, [role="button"], [role="menuitem"]):active))',
    );
    expect(mobileCss).toContain('scale: var(--oc-press-soft-scale)');
    expect(mobileCss).toContain('.pwa-overlay-panel,');
    const compactActiveBlock = mobileCss.slice(
      mobileCss.indexOf('[data-mobile-press-feedback="compact"]'),
    );
    expect(compactActiveBlock).toContain('scale: var(--oc-press-compact-scale)');
  });

  test('engage and release use the shared fast-in spring-like timing', () => {
    expect(mobileCss).toContain('--oc-press-engage-duration: 80ms');
    expect(mobileCss).toContain('--oc-press-engage-ease: cubic-bezier(0.16, 1, 0.3, 1)');
    expect(mobileCss).toContain('--oc-press-release-duration: 260ms');
    expect(mobileCss).toContain('--oc-press-release-ease: cubic-bezier(0.2, 1.28, 0.3, 1)');
    expect(mobileCss).toContain('transition-duration: var(--oc-press-engage-duration)');
    expect(mobileCss).toContain('transition: scale var(--oc-press-release-duration) var(--oc-press-release-ease)');
  });

  test('changes panel scopes its container and lighter soft grow scale', () => {
    const containerRule = mobileCss.match(/([^{}]*\.oc-changes-panel[^{}]*)\{\s*container-type: inline-size;\s*\}/);
    expect(containerRule?.[1]).toContain('.oc-changes-panel');

    const changesPanelRule = mobileCss.match(/\.oc-changes-panel\s*\{([^}]+)\}/);
    expect(changesPanelRule?.[1]).toContain('--oc-press-edge-outset: 2px');
    expect(changesPanelRule?.[1]).toContain('1.004');
    expect(changesPanelRule?.[1]).toContain('1.02');
  });

  test('reduced motion settles immediately while semantic active fill remains', () => {
    const pressPolicyStart = mobileCss.indexOf('--oc-press-soft-scale');
    const reducedMotionBlock = mobileCss.slice(
      mobileCss.indexOf('@media (prefers-reduced-motion: reduce)', pressPolicyStart),
    );
    expect(reducedMotionBlock).toContain('transition: none');
    expect(reducedMotionBlock).toContain('scale: 1 !important');
    expect(mobileCss).toContain('background-color: var(--interactive-active) !important');
    expect(dropdownStylesSource).toContain('active:bg-interactive-active');
  });

  test('dropdown, context, and submenu rows share semantic pressed fill', () => {
    expect(dropdownStylesSource.match(/active:bg-interactive-active/g)).toHaveLength(2);
    expect(dropdownStylesSource).toContain('dropdownMenuItemClass');
    expect(dropdownStylesSource).toContain('dropdownMenuSubTriggerClass');
    expect(contextMenuSource).toContain('dropdownMenuItemClass');
    expect(mobileCss).toContain('[role="menuitem"]:not([aria-disabled="true"]):active');
  });

  test('form fields retain focus ownership without touch scale', () => {
    expect(mobileCss).not.toContain(':where(input, textarea, select');
    expect(mobileCss).toContain(':not([data-slot="select-trigger"])');
    expect(scheduledEditorSource).not.toContain('active:scale');
    expect(scheduledEditorSource).toContain('focus-visible:ring-2');
  });

  test('composer and fill-only action rows preserve their functional opt-outs', () => {
    expect(mobileCss).not.toContain('[data-mobile-composer-surface="true"]:has(textarea:active)');
    expect(mobileCss).not.toContain('@keyframes oc-mobile-composer-expand');
    expect(mobileCss).toContain('Composer surface must not press-scale');
    expect(mobileCss).not.toContain('transition: border-radius');
    expect(rowActionsSource).toContain('data-mobile-press-feedback="none"');
    expect(rowActionsSource).toContain("triggerMobileHaptic('light')");
    expect(rowActionsSource).toContain('active:bg-interactive-active dark:active:bg-interactive-active');
  });

  test('surface triggers drive one outer scale while remaining haptic targets', () => {
    expect(mobileCss).toContain(':not(\n      [data-mobile-press-surface-trigger]\n    )');
    expect(mobileCss).toContain('[data-mobile-press-surface="soft"]:has(');
    expect(projectCardSource).toContain('data-mobile-press-surface-trigger');
    expect(projectCardSource).not.toContain('data-mobile-press-feedback="none"');
    expect(assistantCardSource).toContain('data-mobile-press-surface-trigger');
    expect(assistantCardSource).not.toContain('data-mobile-press-feedback="none"');
  });

  test('shared Button opts icon-sized controls into compact grow', () => {
    expect(buttonSource).toContain('COMPACT_PRESS_SIZES');
    expect(buttonSource).toContain('"icon"');
    expect(buttonSource).toContain('"mobileIcon"');
    expect(buttonSource).toContain('"xs"');
    expect(buttonSource).toContain('data-mobile-press-feedback={compactPress}');
    expect(buttonSource).toContain('active:bg-interactive-active');
    expect(buttonSource).not.toContain('active:scale-[0.96]');
  });

  test('tab, segmented, scheduled, and assistant controls share the grow policy', () => {
    expect(tabBarSource).not.toContain('data-mobile-press-feedback="none"');
    expect(tabBarSource).not.toContain('active:scale');
    expect(mobileCss).not.toContain('transform: scale(0.97)');
    expect(mobileCss).toContain('.oc-mobile-segmented-item:active > .oc-segmented-selected-pill');
    expect(scheduledTasksSource).not.toContain('active:scale');
    expect(scheduledEditorSource).not.toContain('group-active:scale');
    expect(assistantViewSource).not.toContain('active:scale');
  });
});
