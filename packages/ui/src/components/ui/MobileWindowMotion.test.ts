import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clampMobileWindowMotionProgress,
  getMobileWindowMotionFrame,
  getMobileWindowMotionControlledTarget,
  getMobileWindowMotionOperationTarget,
  getNearestMobileWindowMotionSnapPoint,
  getMobileWindowMotionSurfaceLayout,
  getMobileWindowMotionVisibleProgress,
} from './MobileWindowMotionRecipe';
import {
  clampMobileSheetSnapDragHeight,
  getMobileSheetCollapsedHeight,
  getNearestMobileSheetSnapPoint,
  shouldDismissMobileSheetSnap,
} from './useMobileSheetSnap';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mobileSessionStatusBarSource = readFileSync(join(__dirname, '../chat/MobileSessionStatusBar.tsx'), 'utf-8');
const mobileResizableSheetSource = readFileSync(join(__dirname, 'MobileResizableSheet.tsx'), 'utf-8');
const mobileSheetSnapHandleSource = readFileSync(join(__dirname, 'MobileSheetSnapHandle.tsx'), 'utf-8');
const mobileWindowMotionSource = readFileSync(join(__dirname, 'MobileWindowMotion.tsx'), 'utf-8');
const mobileModelPickerPanelSource = readFileSync(join(__dirname, '../model-picker/MobileModelPickerPanel.tsx'), 'utf-8');
const modelControlsSource = readFileSync(join(__dirname, '../chat/ModelControls.tsx'), 'utf-8');
const agentSelectorSource = readFileSync(join(__dirname, '../sections/commands/AgentSelector.tsx'), 'utf-8');
const chatInputSource = readFileSync(join(__dirname, '../chat/ChatInput.tsx'), 'utf-8');
const branchSelectorSource = readFileSync(join(__dirname, '../views/git/BranchSelector.tsx'), 'utf-8');
const mobileStylesSource = readFileSync(join(__dirname, '../../styles/mobile.css'), 'utf-8');
const mobileOverlayPanelSource = readFileSync(join(__dirname, 'MobileOverlayPanel.tsx'), 'utf-8');
const mobileFilesSurfaceSource = readFileSync(join(__dirname, '../../apps/MobileFilesSurface.tsx'), 'utf-8');

describe('MobileWindowMotion recipe', () => {
  test('maps every edge to its closed transform', () => {
    expect(getMobileWindowMotionFrame('left', 0).surfaceTransform).toBe('translate3d(-100%, 0, 0)');
    expect(getMobileWindowMotionFrame('right', 0).surfaceTransform).toBe('translate3d(100%, 0, 0)');
    expect(getMobileWindowMotionFrame('top', 0).surfaceTransform).toBe('translate3d(0, -100%, 0)');
    expect(getMobileWindowMotionFrame('bottom', 0).surfaceTransform).toBe('translate3d(0, 100%, 0)');
  });

  test('clamps progress and derives compositor opacity', () => {
    expect(clampMobileWindowMotionProgress(-2)).toBe(0);
    expect(clampMobileWindowMotionProgress(2)).toBe(1);
    const frame = getMobileWindowMotionFrame('bottom', 0.5);
    expect(frame.progress).toBe(0.5);
    expect(frame.scrimOpacity).toBe(0.5);
    expect(frame.surfaceOpacity).toBe(0.5);
    expect(frame.surfaceTransform).toBe('translate3d(0, 50%, 0)');
  });

  test('maps present commit to the visible endpoint', () => {
    expect(getMobileWindowMotionOperationTarget('present', 'commit')).toBe(1);
  });

  test('maps present cancel to the hidden endpoint', () => {
    expect(getMobileWindowMotionOperationTarget('present', 'cancel')).toBe(0);
  });

  test('maps dismiss commit to the hidden endpoint', () => {
    expect(getMobileWindowMotionOperationTarget('dismiss', 'commit')).toBe(0);
  });

  test('maps dismiss cancel to the visible endpoint', () => {
    expect(getMobileWindowMotionOperationTarget('dismiss', 'cancel')).toBe(1);
  });

  test('maps operation progress to visible progress', () => {
    expect(getMobileWindowMotionVisibleProgress('present', 0.25)).toBe(0.25);
    expect(getMobileWindowMotionVisibleProgress('dismiss', 0.25)).toBe(0.75);
  });

  test('maps controlled state to its visual endpoint', () => {
    expect(getMobileWindowMotionControlledTarget(true)).toBe(1);
    expect(getMobileWindowMotionControlledTarget(false)).toBe(0);
  });

  test('selects the nearest configured sheet height snap point', () => {
    const snapPoints = [0.72, 0.98] as const;
    expect(getNearestMobileWindowMotionSnapPoint(730, 1000, snapPoints)).toBe(0.72);
    expect(getNearestMobileWindowMotionSnapPoint(880, 1000, snapPoints)).toBe(0.98);
    expect(getNearestMobileWindowMotionSnapPoint(800, 1000, snapPoints)).toBe(0.72);
  });

  test('wires the sessions drag handle to 72% and 98% sheet heights', () => {
    expect(mobileSessionStatusBarSource).toContain('<MobileSheetSnapHandle');
    expect(mobileSheetSnapHandleSource).toContain('data-mobile-sheet-snap-handle');
    expect(mobileSheetSnapHandleSource).toContain('min-h-8 cursor-ns-resize touch-none justify-center pt-2.5');
    expect(mobileSessionStatusBarSource).toContain("reservedTargetSelector: '[data-mobile-sheet-snap-handle]'");
    expect(mobileSessionStatusBarSource).toContain("'h-[98dvh] max-h-[98dvh]' : 'h-[72dvh] max-h-[98dvh]'");
    expect(mobileSessionStatusBarSource).toContain('onExitComplete={sessionSheetSnap.reset}');
    expect(mobileWindowMotionSource).toContain('if (!activeRef.current) return;');
  });

  test('renders the recent conversations title opposite the session actions', () => {
    expect(mobileSessionStatusBarSource).toContain('flex items-center justify-between gap-2 px-4 pb-2');
    expect(mobileSessionStatusBarSource).toContain("{t('mobile.sessions.sheet.title')}");
  });

  test('dismisses after dragging below the collapsed sheet threshold', () => {
    expect(shouldDismissMobileSheetSnap(657, 1000, 64)).toBe(false);
    expect(shouldDismissMobileSheetSnap(656, 1000, 64)).toBe(true);
    expect(shouldDismissMobileSheetSnap(600, 1000, 64)).toBe(true);
  });

  test('uses short content height as the collapsed snap and dismissal baseline', () => {
    expect(getMobileSheetCollapsedHeight(1000, 420)).toBe(420);
    expect(getMobileSheetCollapsedHeight(1000, 900)).toBe(720);
    expect(getNearestMobileSheetSnapPoint(650, 1000, 420)).toBe(0.72);
    expect(getNearestMobileSheetSnapPoint(760, 1000, 420)).toBe(0.98);
    expect(shouldDismissMobileSheetSnap(357, 1000, 64, 420)).toBe(false);
    expect(shouldDismissMobileSheetSnap(356, 1000, 64, 420)).toBe(true);
  });

  test('keeps compact resizable sheets content-sized below the collapsed maximum', () => {
    expect(mobileResizableSheetSource).toContain("? 'h-auto max-h-[72dvh]'");
    expect(mobileResizableSheetSource).toContain('const fillAvailableHeight = expanded || !fitContent;');
    expect(chatInputSource).toContain('id="android-media-pick-sheet"');
    expect(chatInputSource).toContain('overflow-hidden rounded-2xl bg-[var(--surface-muted)]');
    expect(chatInputSource).toContain('h-auto min-h-12 w-full justify-start gap-3 rounded-none supports-[corner-shape:squircle]:rounded-none px-4 border-b border-[var(--surface-subtle)] last:border-b-0');
    expect(mobileResizableSheetSource).toContain('trailing?: React.ReactNode;');
    expect(mobileResizableSheetSource).toContain('{trailing ? <div className="flex shrink-0 items-center gap-1.5">{trailing}</div> : null}\n                <div ref={setHeaderActionsSlot} className="contents" />');
    expect(mobileResizableSheetSource).toContain('export const MobileSheetHeaderActions');
    expect(mobileResizableSheetSource).toContain('return createPortal(');
    expect(mobileFilesSurfaceSource).toContain('<MobileSheetHeaderActions>');
    expect(mobileFilesSurfaceSource).not.toContain('justify-end gap-1 px-3 pb-1');
    expect(mobileResizableSheetSource).not.toContain('border-b border-border/40');
    expect(getMobileWindowMotionSurfaceLayout('sheet', 'bottom')).toContain('rounded-t-2xl');
  });

  test('uses the standard resizable sheet for mobile model and agent selection', () => {
    expect(mobileModelPickerPanelSource).toContain("from '@/components/ui/MobileResizableSheet'");
    expect(mobileModelPickerPanelSource).toContain('id={`mobile-model-picker-sheet-${mobileSheetId}`}');
    expect(mobileModelPickerPanelSource).toContain("from '@/components/ui/ScrollableOverlay'");
    expect(mobileModelPickerPanelSource).toContain('outerClassName="min-h-0 flex-1"');
    expect(mobileModelPickerPanelSource).toContain('data-mobile-sheet-no-dismiss=""');
    expect(mobileModelPickerPanelSource).toContain('onPointerUp={(event) => {');
    expect(mobileModelPickerPanelSource).toContain('event.currentTarget.focus({ preventScroll: true })');
    expect(mobileModelPickerPanelSource).toContain('type="text"\n                            value={query}');
    expect(mobileModelPickerPanelSource).not.toContain('type="search"');
    expect(mobileModelPickerPanelSource).toContain('from \'@/components/ui/matchingPress\'');
    expect(mobileModelPickerPanelSource).toContain('onClickCapture');
    expect(mobileWindowMotionSource).toContain('onPointerDown={markOverlayScrimPress}');
    expect(mobileWindowMotionSource).toContain('shouldCommitOverlayScrimDismiss(event)');
    expect(mobileOverlayPanelSource).toContain('onPointerDown={markOverlayScrimPress}');
    expect(mobileOverlayPanelSource).toContain('shouldCommitOverlayScrimDismiss(event)');
    expect(mobileResizableSheetSource).toContain("className={cn(\n              'flex min-h-0 flex-col overflow-hidden',\n              fillAvailableHeight && 'flex-1',\n              bodyClassName,\n            )}");
    expect(mobileResizableSheetSource).toContain("fitContent\n                ? 'flex min-h-9 items-center gap-2 px-4 pb-1'");
    expect(mobileResizableSheetSource).toContain('data-page-scroll-lock="true"');
    expect(agentSelectorSource).toContain("from '@/components/ui/MobileResizableSheet'");
    expect(agentSelectorSource).toContain("from '@/components/ui/ScrollableOverlay'");
    expect(agentSelectorSource).toContain('id={`mobile-agent-selector-sheet-${mobileSheetId}`}');
    expect(agentSelectorSource).toContain('<AgentAvatar name={agent.name} size={16} className="mt-1.5" />');
    expect(agentSelectorSource).toContain('className="mt-2 h-2 w-2 rounded-full bg-primary"');
    expect(modelControlsSource).toContain('id={`mobile-agent-picker-sheet-${mobileAgentSheetId}`}');
    expect(modelControlsSource).toContain('<MobileResizableSheet');
    expect(modelControlsSource).toContain('<ScrollableOverlay');
    expect(mobileWindowMotionSource).toContain("className={cn('oc-mobile-floating-shell'");
    expect(mobileWindowMotionSource).toContain("surface?.focus({ preventScroll: true })");
    expect(mobileWindowMotionSource).not.toContain("(surface?.querySelector<HTMLElement>(FOCUSABLE) ?? surface)?.focus()");
  });

  test('uses compact resizable sheets for mobile draft project and branch selection', () => {
    expect(chatInputSource).toContain('oc-mobile-draft-target-selectors');
    expect(chatInputSource).toContain('mobile-draft-project-picker-sheet-');
    expect(chatInputSource).toContain('<ScrollableOverlay outerClassName="min-h-0 flex-1" disableHorizontal>');
    expect(chatInputSource).toContain('data-mobile-sheet-no-dismiss=""');
    expect(branchSelectorSource).toContain("presentation?: 'dropdown' | 'mobile-sheet'");
    expect(branchSelectorSource).toContain('mobile-draft-branch-picker-sheet-');
    expect(branchSelectorSource).toContain("data-mobile-sheet-no-dismiss={presentation === 'mobile-sheet' ? '' : undefined}");
    expect(mobileStylesSource).toContain('.oc-mobile-draft-target-selectors');
    expect(mobileStylesSource).toContain('height: 26px !important;');
  });

  test('lets a dismissible sheet track downward continuously to zero height', () => {
    expect(clampMobileSheetSnapDragHeight(-100, 1000, true)).toBe(0);
    expect(clampMobileSheetSnapDragHeight(360, 1000, true)).toBe(360);
    expect(clampMobileSheetSnapDragHeight(1000, 1000, true)).toBe(980);
    expect(clampMobileSheetSnapDragHeight(360, 1000, false)).toBe(720);
  });

  test('maps every sheet edge to its anchored layout', () => {
    expect(getMobileWindowMotionSurfaceLayout('sheet', 'bottom')).toContain('mt-auto');
    expect(getMobileWindowMotionSurfaceLayout('sheet', 'bottom')).toContain('mx-auto');
    expect(getMobileWindowMotionSurfaceLayout('sheet', 'bottom')).toContain('pwa-overlay-panel');
    expect(getMobileWindowMotionSurfaceLayout('sheet', 'bottom')).toContain('pb-[max(0.5rem,var(--oc-app-bottom-safe,0px),var(--oc-safe-area-bottom,env(safe-area-inset-bottom,0px)))]');
    expect(mobileOverlayPanelSource).toContain('pb-[max(0.5rem,var(--oc-app-bottom-safe,0px),var(--oc-safe-area-bottom,env(safe-area-inset-bottom,0px)))]');
    expect(getMobileWindowMotionSurfaceLayout('sheet', 'top')).toContain('mb-auto');
    expect(getMobileWindowMotionSurfaceLayout('sheet', 'top')).toContain('mx-auto');
    expect(getMobileWindowMotionSurfaceLayout('sheet', 'left')).toContain('rounded-r-xl');
    expect(getMobileWindowMotionSurfaceLayout('sheet', 'right')).toContain('rounded-l-xl');
    for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
      const layout = getMobileWindowMotionSurfaceLayout('page', edge);
      expect(layout).toContain('flex min-h-0 flex-col bg-background shadow-none');
      expect(layout).toContain('h-full w-full');
      expect(layout).not.toContain('pwa-overlay-panel');
    }
  });

  test('deactivates a committed close without a reconcile pass that re-expands the sheet', () => {
    // A rAF reconcile used to re-settle from the pre-commit `openRef` value and
    // flashed the surface back to full screen for a frame or two. The controlled
    // `open` prop drives any later correction through the open-driven effect.
    expect(mobileWindowMotionSource).not.toContain('reconcileFrameRef');
    expect(mobileWindowMotionSource).not.toContain('cancelReconcileFrame');
    expect(mobileWindowMotionSource).toContain('if (target === 0) deactivate();');
    expect(mobileWindowMotionSource).toContain("settle(getMobileWindowMotionControlledTarget(open)");
    expect(getMobileWindowMotionOperationTarget('dismiss', 'commit')).toBe(0);
    expect(getMobileWindowMotionOperationTarget('dismiss', 'cancel')).toBe(1);
  });

  test('keeps the open prop as the only source of controlled motion truth', () => {
    // Dismiss cancel and dismiss commit must land on opposite endpoints, and the
    // standard-mode settle must read the prop rather than a captured interaction value.
    expect(getMobileWindowMotionControlledTarget(true)).toBe(1);
    expect(getMobileWindowMotionControlledTarget(false)).toBe(0);
    expect(mobileWindowMotionSource).toContain("if (mountedRef.current && modeRef.current === 'standard')");
    expect(mobileWindowMotionSource).toContain("if (!mounted || modeRef.current !== 'standard') return;");
  });
});
