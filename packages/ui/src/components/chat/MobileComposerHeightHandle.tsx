import { memo, useLayoutEffect, useRef, type RefObject } from 'react';
import { HeightSnapHandle } from '../ui/HeightSnapHandle';
import { useMobileComposerSnap } from './useMobileComposerSnap';

/** Mounted only for a nonempty web composer; text edits never enter this leaf. */
/**
 * 修改此组件时必须保留的约束：
 * - 输入热路径隔离：不要把 message、光标、临时对象或内联回调传入这里，也不要把
 *   useMobileComposerSnap 搬回 ChatInput。父级必须传稳定 ref、DraftKey 字符串和 setter；
 *   普通文字变化不能执行此叶子的 Hook、Effect 或监听器重绑。memo 本身不足以保证这一点。
 * - 高度只有一个写入方：拖动、吸附动画期间及 min/full 档由 snap 接管，auto 静止时
 *   才交回 useComposerTextareaAutosize。settling 不能当成 idle；提前恢复 max-height
 *   会裁断动画，提前测量 scrollHeight 会把动画高度当作内容高度，造成松手跳变和回弹。
 * - 此叶子独占下方三个 data 属性；不要在父级 JSX 再写同名属性。父级只接收离散的
 *   manualHeight 信号，不接收逐帧高度。帧更新、指针捕获、动画取消仍由 useHeightSnap 负责。
 * - bar 留在卡片内部，文字顶部 padding 要为触摸区留空间；不要重挂载 textarea 来切档，
 *   否则会丢失焦点、选区或 IME 状态。原生 iOS composer 的排除条件由调用方保留。
 * - 改动 props、Effect、布局或动画后，运行 MobileComposerHeightHandle.test.tsx 和
 *   useMobileComposerSnap.test.tsx，并在浏览器验证松手逐帧高度及每档至少 50 次输入。
 *   自动档允许必要的内容测量；min/full 档不应因文字变化执行自动撑高 Effect。
 *   完整性能验收口径见 ../../composer/DOCUMENTATION.md 的 Input responsiveness contract。
 */
export const MobileComposerHeightHandle = memo(function MobileComposerHeightHandle({ inputRef, draftID, ariaLabel, onManualHeightChange }: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draftID: string | null;
  ariaLabel: string;
  onManualHeightChange: (manual: boolean) => void;
}) {
  const handleRef = useRef<HTMLDivElement>(null);
  const snap = useMobileComposerSnap({ enabled: true, hasContent: true, draftID, inputRef });
  const { snapPoint, manualHeight, dragging, settling } = snap;

  // 在绘制前同步高度所有权和 CSS 约束；依赖只能是离散交互状态，不得加入输入内容。
  useLayoutEffect(() => {
    const surface = handleRef.current?.closest<HTMLElement>('[data-mobile-composer-surface]');
    if (surface) {
      surface.dataset.composerHeightSnap = snapPoint;
      surface.toggleAttribute('data-composer-height-manual', manualHeight);
      if (dragging || settling) surface.dataset.mobileComposerResizing = 'true';
      else delete surface.dataset.mobileComposerResizing;
    }
    onManualHeightChange(manualHeight);
  }, [snapPoint, manualHeight, dragging, settling, onManualHeightChange]);

  // 内容清空/离开页面时撤销 DOM 标记并归还高度所有权；不要改成延迟到绘制后的清理。
  useLayoutEffect(() => {
    const surface = handleRef.current?.closest<HTMLElement>('[data-mobile-composer-surface]');
    return () => {
      surface?.removeAttribute('data-composer-height-snap');
      surface?.removeAttribute('data-composer-height-manual');
      surface?.removeAttribute('data-mobile-composer-resizing');
      onManualHeightChange(false);
    };
  }, [onManualHeightChange]);

  return <HeightSnapHandle
    ref={handleRef}
    data-mobile-composer-snap-handle
    aria-label={ariaLabel}
    aria-valuemin={0}
    aria-valuemax={2}
    aria-valuenow={snapPoint === 'min' ? 0 : snapPoint === 'auto' ? 1 : 2}
    className="absolute top-0 left-1/2 z-40 h-6 w-20 -translate-x-1/2 items-center"
    onPointerDown={snap.handlePointerDown}
    onPointerMove={snap.handlePointerMove}
    onPointerUp={snap.handlePointerUp}
    onPointerCancel={snap.handlePointerCancel}
    onLostPointerCapture={snap.handleLostPointerCapture}
    onClick={snap.handleClick}
    onKeyDown={snap.handleKeyDown}
  />;
});
