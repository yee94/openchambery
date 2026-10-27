import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobileComposerHeightHandle } from './MobileComposerHeightHandle';

const work = vi.hoisted(() => ({ hooks: 0 }));
vi.mock('./useMobileComposerSnap', async (importOriginal) => {
  const original = await importOriginal<typeof import('./useMobileComposerSnap')>();
  return { ...original, useMobileComposerSnap: (...args: Parameters<typeof original.useMobileComposerSnap>) => {
    work.hooks++;
    return original.useMobileComposerSnap(...args);
  } };
});

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ChatInput.tsx'), 'utf8');
const ast = ts.createSourceFile('ChatInput.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let jsx = '';
function visit(node: ts.Node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'MobileComposerHeightHandle') jsx = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
const compiled = ts.transpileModule(`const render = (scope) => { const { React, MobileComposerHeightHandle, textareaRef, draftKey, draftKeyString, t, setMobileComposerManualHeight } = scope; return (${jsx}); };`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const renderHandle = new Function(`${compiled}; return render;`)();

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function Probe({ message, draftID = 'one' }: { message: string; draftID?: string }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [manual, setMobileComposerManualHeight] = useState(false);
  return <div data-mobile-composer-surface data-manual={manual}>
    {message.length > 0 ? renderHandle({ React, MobileComposerHeightHandle, textareaRef,
      draftKey: { id: draftID }, draftKeyString: (key: { id: string }) => key.id,
      t: () => 'Resize', setMobileComposerManualHeight }) : null}
    <textarea ref={textareaRef} value={message} readOnly />
  </div>;
}
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 600, 390, this.tagName === 'TEXTAREA' ? 120 : 160);
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it('does zero snap hook or listener work across 50 edits at the production JSX boundary, including after a drag', async () => {
  expect(jsx).not.toBe('');
  await act(async () => root.render(<Probe message="draft" />));
  const node = host.querySelector('textarea');
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  const type = async () => {
    work.hooks = 0; add.mockClear(); remove.mockClear();
    for (let i = 0; i < 50; i++) await act(async () => root.render(<Probe message={`draft ${i}`} />));
    expect(work.hooks).toBe(0);
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(host.querySelector('textarea')).toBe(node);
  };
  await type();
  const handle = host.querySelector('[data-mobile-composer-snap-handle]')!;
  await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(host.firstElementChild?.getAttribute('data-composer-height-snap')).toBe('min');
  expect(host.firstElementChild?.getAttribute('data-manual')).toBe('true');
  await type();
  await act(async () => root.render(<Probe message="other draft" draftID="two" />));
  expect(work.hooks).toBeGreaterThan(0);
  expect(host.firstElementChild?.getAttribute('data-composer-height-snap')).toBe('auto');
  expect(host.firstElementChild?.getAttribute('data-manual')).toBe('false');
  await act(async () => root.render(<Probe message="" draftID="two" />));
  expect(host.querySelector('[data-mobile-composer-snap-handle]')).toBeNull();
  expect(host.firstElementChild?.hasAttribute('data-composer-height-snap')).toBe(false);
});

it('keeps the initial input reservation when text grows and adjusts only accessory height', () => {
  const start = source.indexOf('const publishComposerOccupancy = useEvent(');
  const end = source.indexOf('\n    useResizeObserver(', start);
  const callback = source.slice(start, end);
  const form = document.createElement('form');
  const overlay = document.createElement('div');
  overlay.className = 'yuri-mobile-composer-foot--overlay';
  overlay.append(form);
  let formHeight = 160;
  const measure = vi.fn(() => formHeight);
  Object.defineProperty(form, 'offsetHeight', { get: measure });
  const accessory = { offsetHeight: 40 };
  const publish = vi.fn(() => '160px');
  const create = new Function('composerFormRef', 'nativeAccessoryRef', 'publishMobileComposerOccupancy', 'document', `
    const publishesComposerOccupancy = true;
    const composerBaseOccupancyRef = { current: null };
    const composerOccupancyWrittenRef = { current: null };
    const useEvent = fn => fn;
    ${callback}
    return publishComposerOccupancy;
  `);
  const update = create({ current: form }, { current: accessory }, publish, document);
  update();
  expect(publish).toHaveBeenLastCalledWith(document.documentElement, 160);
  measure.mockClear();
  formHeight = 460;
  update();
  expect(publish).toHaveBeenLastCalledWith(document.documentElement, 160);
  accessory.offsetHeight = 100;
  update();
  expect(publish).toHaveBeenLastCalledWith(document.documentElement, 220);
  accessory.offsetHeight = 0;
  update();
  expect(publish).toHaveBeenLastCalledWith(document.documentElement, 120);
  expect(measure).not.toHaveBeenCalled();
  expect(source).toContain('useResizeObserver(publishesComposerOccupancy ? nativeAccessoryRef : null, publishComposerOccupancy)');
});
