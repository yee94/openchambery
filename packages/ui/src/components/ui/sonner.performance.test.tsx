import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { toast } from 'sonner';
import { Toaster } from './sonner';

vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));

afterEach(() => { vi.restoreAllMocks(); toast.dismiss(); });

test('toast pinning ignores transcript scroll/stream mutations and still repairs toast styles', async () => {
  const host = document.createElement('div');
  const transcript = document.createElement('div');
  document.body.append(host, transcript);
  const root = createRoot(host);
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  try {
    await act(async () => { root.render(<Toaster />); });
    toast('Performance guard', { id: 'pin-performance', duration: Infinity });
    await settle();
    await settle();
    const item = host.querySelector<HTMLElement>('[data-sonner-toast]')!;
    expect(item).not.toBeNull();
    expect(host.querySelector('[data-sonner-toaster]')?.getAttribute('data-x-position')).toBe('right');
    expect(host.querySelector('[data-sonner-toaster]')?.getAttribute('data-y-position')).toBe('bottom');
    const shadow = item.style.getPropertyValue('box-shadow');
    expect(item.style.getPropertyPriority('box-shadow')).toBe('important');
    const documentScan = vi.spyOn(document, 'querySelectorAll');
    const subtreeScan = vi.spyOn(Element.prototype, 'querySelectorAll');
    for (let i = 0; i < 50; i++) {
      transcript.style.transform = `translateY(${i}px)`;
      transcript.append(document.createTextNode('token '));
      await settle();
    }
    expect(documentScan).not.toHaveBeenCalled();
    expect(subtreeScan).not.toHaveBeenCalled();
    item.style.cssText = 'color: red';
    item.tabIndex = 0;
    await settle();
    expect(item.style.getPropertyValue('box-shadow')).toBe(shadow);
    expect(item.style.getPropertyPriority('box-shadow')).toBe('important');
    expect(item.tabIndex).toBe(-1);
    document.documentElement.classList.add('dark');
    await settle();
    expect(item.style.getPropertyValue('box-shadow')).not.toBe(shadow);
    await act(async () => { root.render(<Toaster position="top-center" />); });
    expect(host.querySelector('[data-sonner-toaster]')?.getAttribute('data-x-position')).toBe('center');
    expect(host.querySelector('[data-sonner-toaster]')?.getAttribute('data-y-position')).toBe('top');
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    transcript.remove();
    document.documentElement.classList.remove('dark');
  }
});
