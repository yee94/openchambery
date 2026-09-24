import React from 'react';
import { useEvent, useResizeObserver } from '@reactuses/core';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { BrowserProviderSummary, SurfaceInputEvent, SurfaceModifiers } from '@/lib/browser-provider/contract';
import {
  BrowserProviderSurfaceClient,
  type SurfaceClientHandlers,
  type SurfaceConnectionState,
  type SurfaceControlState,
  type SurfaceFrame,
} from '@/lib/browser-provider/surface-client';

type Props = {
  provider: BrowserProviderSummary;
  clientFactory?: (providerId: string, handlers: SurfaceClientHandlers) => Pick<
    BrowserProviderSurfaceClient,
    'start' | 'dispose' | 'ack' | 'sendInput' | 'release' | 'resize' | 'retry'
  >;
};

const RESIZE_DEBOUNCE_MS = 250;

const modifiersOf = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): SurfaceModifiers => ({
  alt: event.altKey,
  ctrl: event.ctrlKey,
  meta: event.metaKey,
  shift: event.shiftKey,
});

const isPasteChord = (event: React.KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'v';

const defaultClientFactory: Props['clientFactory'] = (providerId, handlers) =>
  new BrowserProviderSurfaceClient(providerId, handlers);

/**
 * Live picture of the selected browser provider. Input takes control; the
 * hand-back button asks the host to let the extension answer again.
 */
export const BrowserProviderRail: React.FC<Props> = ({ provider, clientFactory = defaultClientFactory }) => {
  const { t } = useI18n();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const clientRef = React.useRef<ReturnType<NonNullable<Props['clientFactory']>> | null>(null);
  const frameSizeRef = React.useRef<{ width: number; height: number } | null>(null);
  const batchRef = React.useRef<SurfaceInputEvent[]>([]);
  const flushRef = React.useRef<number | null>(null);
  const controlRef = React.useRef<SurfaceControlState>({ controller: 'none', mine: false });
  const resizeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const [connection, setConnection] = React.useState<SurfaceConnectionState>({ status: 'connecting' });
  const [control, setControlState] = React.useState<SurfaceControlState>({ controller: 'none', mine: false });
  const [title, setTitle] = React.useState('');
  const [agentActive, setAgentActive] = React.useState(false);
  const [hasFrame, setHasFrame] = React.useState(false);
  const [focused, setFocused] = React.useState(false);

  const setControl = useEvent((next: SurfaceControlState) => {
    controlRef.current = next;
    setControlState(next);
  });

  const drawFrame = useEvent(async (frame: SurfaceFrame) => {
    const canvas = canvasRef.current;
    const client = clientRef.current;
    if (!canvas || !client) return;
    try {
      const bitmap = await createImageBitmap(new Blob([frame.bytes], { type: frame.mime }));
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, frame.width, frame.height);
      bitmap.close();
      frameSizeRef.current = { width: frame.width, height: frame.height };
      setHasFrame(true);
      setTitle(frame.title ?? '');
      setAgentActive(frame.agentActive);
    } catch {
      // An undecodable frame is skipped; the next one replaces it.
    } finally {
      client.ack(frame.seq);
    }
  });

  const handlersRef = React.useRef<SurfaceClientHandlers>({
    onFrame: (frame) => { void drawFrame(frame); },
    onControl: setControl,
    onConnection: setConnection,
  });
  handlersRef.current = {
    onFrame: (frame) => { void drawFrame(frame); },
    onControl: setControl,
    onConnection: setConnection,
  };
  const factoryRef = React.useRef(clientFactory);
  factoryRef.current = clientFactory;

  React.useEffect(() => {
    if (!provider.surface) return undefined;
    const client = factoryRef.current(provider.id, {
      onFrame: (frame) => { void handlersRef.current.onFrame(frame); },
      onControl: (state) => { handlersRef.current.onControl(state); },
      onConnection: (state) => { handlersRef.current.onConnection(state); },
    });
    clientRef.current = client;
    client.start();
    return () => {
      client.dispose();
      if (clientRef.current === client) clientRef.current = null;
      if (flushRef.current !== null) cancelAnimationFrame(flushRef.current);
      flushRef.current = null;
      batchRef.current = [];
      frameSizeRef.current = null;
      setHasFrame(false);
      setConnection({ status: 'connecting' });
      setControl({ controller: 'none', mine: false });
    };
  }, [provider.id, provider.surface, setControl]);

  const publishResize = useEvent(() => {
    const container = containerRef.current;
    if (!container || !provider.surface) return;
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null;
      const rect = container.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const width = Math.round(rect.width * scale);
      const height = Math.round(rect.height * scale);
      if (width > 0 && height > 0) clientRef.current?.resize(width, height);
    }, RESIZE_DEBOUNCE_MS);
  });
  useResizeObserver(provider.surface ? containerRef : null, publishResize);

  const queue = useEvent((event: SurfaceInputEvent) => {
    batchRef.current.push(event);
    if (flushRef.current !== null) return;
    flushRef.current = requestAnimationFrame(() => {
      flushRef.current = null;
      const events = batchRef.current;
      batchRef.current = [];
      clientRef.current?.sendInput(events);
    });
  });

  const framePoint = (event: React.PointerEvent | React.WheelEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    const size = frameSizeRef.current;
    if (!canvas || !size) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * size.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * size.height),
    };
  };

  const onPointer = (action: 'down' | 'up' | 'move') => (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!hasFrame) return;
    if (action === 'move' && event.buttons === 0 && !(controlRef.current.controller === 'user' && controlRef.current.mine)) return;
    const point = framePoint(event);
    if (!point) return;
    if (action === 'down') {
      containerRef.current?.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (action === 'up' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    queue({
      type: 'pointer',
      action,
      x: point.x,
      y: point.y,
      button: action === 'move' ? -1 : event.button,
      buttons: event.buttons,
      modifiers: modifiersOf(event),
    });
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    if (!hasFrame) return;
    const point = framePoint(event);
    if (!point) return;
    event.preventDefault();
    queue({ type: 'wheel', x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiersOf(event) });
  };

  const onKey = (action: 'down' | 'up') => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!hasFrame || isPasteChord(event)) return;
    event.preventDefault();
    event.stopPropagation();
    queue({ type: 'key', action, key: event.key, code: event.code, modifiers: modifiersOf(event) });
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (!hasFrame) return;
    const text = event.clipboardData.getData('text/plain');
    event.preventDefault();
    if (text) queue({ type: 'text', text });
  };

  const release = useEvent(() => {
    clientRef.current?.release();
  });
  const retry = useEvent(() => {
    clientRef.current?.retry();
  });

  if (!provider.surface) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t('layout.browserProvider.noSurface', { name: provider.name })}
      </div>
    );
  }

  const statusKey = (() => {
    if (connection.status === 'connecting') return 'layout.browserProvider.status.connecting';
    if (connection.status === 'reconnecting') return 'layout.browserProvider.status.reconnecting';
    if (connection.status === 'ended') {
      if (connection.reason === 'service-stopped') return 'layout.browserProvider.ended.service-stopped';
      if (connection.reason === 'extension-unavailable') return 'layout.browserProvider.ended.extension-unavailable';
      return 'layout.browserProvider.ended.host-shutdown';
    }
    if (control.controller === 'user') {
      return control.mine ? 'layout.browserProvider.status.youControl' : 'layout.browserProvider.status.otherControls';
    }
    if (control.controller === 'agent' || agentActive) return 'layout.browserProvider.status.agentWorking';
    return focused ? 'layout.browserProvider.status.readyFocused' : 'layout.browserProvider.status.ready';
  })();
  const holding = control.controller === 'user' && control.mine;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={title || provider.name}>
          {title || provider.name}
        </span>
        <span
          className={cn('shrink-0 truncate text-xs', holding ? 'text-foreground' : 'text-muted-foreground')}
          aria-live="polite"
        >
          {t(statusKey)}
        </span>
        {holding ? (
          <Button size="xs" variant="outline" onClick={release}>
            {t('layout.browserProvider.handBack')}
          </Button>
        ) : null}
        {connection.status === 'ended' ? (
          <Button size="xs" variant="outline" onClick={retry}>
            {t('layout.browserProvider.retry')}
          </Button>
        ) : null}
      </div>
      <div
        ref={containerRef}
        tabIndex={0}
        role="application"
        aria-label={t('layout.browserProvider.canvasAria', { name: provider.name })}
        className={cn(
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden outline-none',
          focused && 'ring-1 ring-inset ring-[var(--interactive-selection-border)]',
        )}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKey('down')}
        onKeyUp={onKey('up')}
        onPaste={onPaste}
      >
        <canvas
          ref={canvasRef}
          className={cn('max-h-full max-w-full', hasFrame ? 'block' : 'hidden', control.controller === 'user' && !control.mine ? 'cursor-not-allowed' : 'cursor-default')}
          onPointerDown={onPointer('down')}
          onPointerMove={onPointer('move')}
          onPointerUp={onPointer('up')}
          onWheel={onWheel}
          onContextMenu={(event) => event.preventDefault()}
        />
        {!hasFrame || connection.status !== 'open' ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t(connection.status === 'ended'
              ? connection.reason === 'service-stopped'
                ? 'layout.browserProvider.ended.service-stopped'
                : connection.reason === 'extension-unavailable'
                  ? 'layout.browserProvider.ended.extension-unavailable'
                  : 'layout.browserProvider.ended.host-shutdown'
              : connection.status === 'reconnecting'
                ? 'layout.browserProvider.status.reconnecting'
                : 'layout.browserProvider.status.connecting')}
          </div>
        ) : null}
      </div>
    </div>
  );
};
