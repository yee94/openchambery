import React from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Icon } from "@/components/icon/Icon";
import { useI18n } from "@/lib/i18n";

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
      {showUpdateButton && onOpenUpdate ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-auto size-6 rounded-full [corner-shape:round] supports-[corner-shape:squircle]:rounded-full border border-[var(--primary-base)] bg-[var(--primary-base)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)] hover:text-[var(--primary-foreground)] active:bg-[var(--primary-hover)]"
              onClick={onOpenUpdate}
              aria-label={t("sessions.sidebar.footer.actions.update")}
            >
              <Icon name="download" className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            <p>{t("sessions.sidebar.footer.actions.update")}</p>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
