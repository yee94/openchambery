import React from "react";
import { useMutation } from "@tanstack/react-query";
import { useEvent } from "@reactuses/core";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Icon } from "@/components/icon/Icon";
import { useI18n } from "@/lib/i18n";
import { DeviceConnections } from './DeviceConnections';
import { useUpdateStore } from '@/stores/useUpdateStore';

type Props = {
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenUpdate?: () => void;
  showRuntimeButtons?: boolean;
  showUpdateButton?: boolean;
};

// Match titlebar sidebar toggles: quiet 28×28 chrome with 16px glyphs that
// rest at 55% foreground and lift on hover/focus.
const footerIconButtonClassName =
  "group size-7 rounded-md text-muted-foreground/75 transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary";
const footerIconClassName =
  "size-4 text-foreground/55 transition-colors group-hover:text-foreground group-focus-visible:text-foreground";

function SidebarUpdateButton({ onOpenUpdate }: { onOpenUpdate: () => void }) {
  const { t } = useI18n();
  const downloading = useUpdateStore((state) => state.downloading);
  const downloaded = useUpdateStore((state) => state.downloaded);
  const error = useUpdateStore((state) => state.error);
  // Read the action at call time so the mutation never captures a stale store.
  const restartToUpdate = useUpdateStore((state) => state.restartToUpdate);
  const percent = useUpdateStore((state) => state.progress?.total
    ? Math.round(state.progress.downloaded / state.progress.total * 100)
    : null);
  // A queued bundle restarts immediately; that click must land once, so the
  // mutation owns the in-flight state and blocks re-entry.
  const restart = useMutation({
    mutationKey: ['update', 'restart-to-apply'],
    mutationFn: () => restartToUpdate(),
    retry: false,
    networkMode: 'always',
  });
  const restarting = restart.isPending;
  const launchGate = React.useRef(false);
  const handleClick = useEvent(() => {
    if (downloaded && !restarting) {
      if (launchGate.current) return;
      launchGate.current = true;
      restart.mutate();
      return;
    }
    onOpenUpdate();
  });
  const updateLabel = error || (downloading
    ? t('updateDialog.status.downloading')
    : restarting
      ? t('updateDialog.status.updating')
      : downloaded
        ? t('updateDialog.actions.restartToUpdate')
        : t('sessions.sidebar.footer.actions.update'));

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={`ml-auto ${footerIconButtonClassName} disabled:opacity-100`}
          onClick={handleClick}
          disabled={restarting}
          aria-busy={restarting || undefined}
          aria-label={updateLabel}
        >
          {downloading ? (
            <svg
              viewBox="0 0 18 18"
              className={percent === null ? 'size-4 animate-spin' : 'size-4 -rotate-90'}
              role="progressbar"
              aria-label={updateLabel}
              aria-valuenow={percent ?? undefined}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <circle cx="9" cy="9" r="7.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
              <circle
                cx="9" cy="9" r="7.5" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                pathLength="100" strokeDasharray="100"
                strokeDashoffset={100 - (percent === null ? 25 : Math.max(0, Math.min(100, percent)))}
                className="transition-[stroke-dashoffset] duration-300"
              />
            </svg>
          ) : (
            <Icon name="download" className={footerIconClassName} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <p>{updateLabel}{downloading && percent !== null ? ` ${percent}%` : ''}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function SidebarFooter({
  onOpenSettings,
  onOpenShortcuts,
  onOpenUpdate,
  showRuntimeButtons = true,
  showUpdateButton = false,
}: Props): React.ReactNode {
  const { t } = useI18n();

  return (
    <div className="flex shrink-0 items-center justify-start gap-1 px-2.5 py-2">
      {showRuntimeButtons ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={footerIconButtonClassName}
                onClick={onOpenSettings}
                aria-label={t("sessions.sidebar.footer.actions.settings")}
              >
                <Icon name="settings-3" className={footerIconClassName} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {t("sessions.sidebar.footer.actions.settings")}
            </TooltipContent>
          </Tooltip>
          <DeviceConnections />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={footerIconButtonClassName}
                onClick={onOpenShortcuts}
                aria-label={t("sessions.sidebar.footer.actions.shortcuts")}
              >
                <Icon name="question" className={footerIconClassName} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {t("sessions.sidebar.footer.actions.shortcuts")}
            </TooltipContent>
          </Tooltip>
        </>
      ) : null}
      {showUpdateButton && onOpenUpdate ? <SidebarUpdateButton onOpenUpdate={onOpenUpdate} /> : null}
    </div>
  );
}
