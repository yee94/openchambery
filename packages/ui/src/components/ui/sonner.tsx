"use client"

import * as React from "react"
import { Toaster as Sonner } from "sonner"
import type { ToasterProps } from "sonner"
import { Icon } from "@/components/icon/Icon"

// Shared toast styles set --yuri-toast-shadow to the glass elevation. The pin must
// read that token; a hardcoded shadow here would flatten custom toasts.
const SHADOW_DARK =
  "var(--yuri-toast-shadow, inset 0 1px 0 0 rgba(255,255,255,0.12), inset 0 0 0 1px rgba(255,255,255,0.08), 0 0 0 1px rgba(0,0,0,0.36), 0 1px 1px -0.5px rgba(0,0,0,0.22), 0 3px 3px -1.5px rgba(0,0,0,0.20), 0 6px 6px -3px rgba(0,0,0,0.16))"

const SHADOW_LIGHT =
  "var(--yuri-toast-shadow, inset 0 1px 0 0 rgba(255,255,255,0.8), inset 0 0 0 1px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.10), 0 1px 2px -0.5px rgba(0,0,0,0.08), 0 4px 8px -2px rgba(0,0,0,0.08), 0 12px 20px -4px rgba(0,0,0,0.08))"

const TOAST_ICONS = {
  success: <Icon name="checkbox-circle" weight="medium" className="yuri-toast-status-icon size-5" />,
  info: <Icon name="information" weight="medium" className="yuri-toast-status-icon size-5" />,
  warning: <Icon name="error-warning" weight="medium" className="yuri-toast-status-icon size-5" />,
  error: <Icon name="close-circle" weight="medium" className="yuri-toast-status-icon size-5" />,
  loading: <Icon name="loader-4" weight="medium" className="yuri-toast-status-icon size-5 animate-spin motion-reduce:animate-none" />,
}

function useIsDarkTheme() {
  const getIsDark = () =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
  const [isDark, setIsDark] = React.useState(getIsDark)

  React.useEffect(() => {
    const update = () => setIsDark(getIsDark())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    update()
    return () => observer.disconnect()
  }, [])

  return isDark
}

// Sonner makes each toast focusable (tabIndex=0) and defines a `:focus-visible`
// box-shadow that erases our custom elevation on click. We pin every toast's
// box-shadow as an !important inline style and strip tabIndex so the element
// can't receive focus-induced style swaps.
function usePinnedToastStyles(shadow: string, scopeRef: React.RefObject<HTMLDivElement | null>) {
  React.useEffect(() => {
    const scope = scopeRef.current
    if (!scope) return
    const pinnedStyle = document.createElement("div").style
    pinnedStyle.setProperty("box-shadow", shadow, "important")
    pinnedStyle.setProperty("outline", "none", "important")

    const apply = (el: HTMLElement) => {
      if (el.style.getPropertyValue("box-shadow") !== pinnedStyle.getPropertyValue("box-shadow") || el.style.getPropertyPriority("box-shadow") !== "important") {
        el.style.setProperty("box-shadow", shadow, "important")
      }
      if (el.style.getPropertyValue("outline") !== pinnedStyle.getPropertyValue("outline") || el.style.getPropertyPriority("outline") !== "important") {
        el.style.setProperty("outline", "none", "important")
      }
      if (el.getAttribute("tabindex") === "0") el.setAttribute("tabindex", "-1")
    }

    const applyToAll = () => {
      scope
        .querySelectorAll<HTMLElement>("[data-sonner-toast]")
        .forEach(apply)
    }

    applyToAll()

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        // Re-pin in case sonner mutates style.cssText on interactions.
        // Attribute repair is toast-local; our own idempotent writes settle.
        if (m.type === "attributes" && m.target instanceof HTMLElement && m.target.matches("[data-sonner-toast]")) apply(m.target)
        m.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return
          if (node.matches?.("[data-sonner-toast]")) apply(node)
          node
            .querySelectorAll?.<HTMLElement>("[data-sonner-toast]")
            .forEach(apply)
        })
      }
    })

    observer.observe(scope, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "tabindex", "data-expanded", "data-swiping"],
    })

    return () => observer.disconnect()
  }, [shadow, scopeRef])
}

const Toaster = ({ ...props }: ToasterProps) => {
  const isDark = useIsDarkTheme()
  const shadow = isDark ? SHADOW_DARK : SHADOW_LIGHT
  const scopeRef = React.useRef<HTMLDivElement>(null)
  usePinnedToastStyles(shadow, scopeRef)

  return (
    <div ref={scopeRef} style={{ display: "contents" }}>
    <Sonner
      theme={isDark ? "dark" : "light"}
      className="toaster group"
      position="bottom-right"
      closeButton={false}
      duration={3500}
      icons={TOAST_ICONS}
      toastOptions={{
        classNames: {
          toast:
            "group/toast toast !flex !min-w-[min(var(--width),calc(100vw-2rem))] !max-w-[calc(100vw-2rem)] !items-center !rounded-[var(--yuri-toast-radius,var(--radius-xl))] !border-0 !px-[var(--yuri-toast-padding-x,0.875rem)] !py-[var(--yuri-toast-padding-y,0.75rem)] !gap-[var(--yuri-toast-gap,0.625rem)] !text-foreground",
          content: "!min-w-0 !flex-1 !text-left",
          title: "typography-ui-label !font-medium !text-foreground",
          description: "typography-meta !text-muted-foreground !mt-0",
          actionButton:
            "!ms-0 !me-0 !shrink-0 !rounded-[var(--radius-md)] !bg-[var(--yuri-toast-action-background,var(--surface-muted))] !text-[var(--yuri-toast-action-foreground,var(--foreground))] hover:!opacity-85 !px-2 !py-1 typography-meta !font-medium transition-opacity",
          cancelButton:
            "!ms-0 !me-0 !shrink-0 !rounded-[var(--radius-md)] !bg-[var(--yuri-toast-cancel-background,var(--interactive-hover))] !text-[var(--yuri-toast-cancel-foreground,var(--foreground))] hover:!bg-[var(--interactive-active)] !px-2 !py-1 typography-meta !font-medium transition-colors",
          closeButton:
            "!rounded-[var(--radius-md)] !bg-[var(--interactive-hover)] !text-foreground hover:!bg-[var(--interactive-active)]",
          icon: "!shrink-0 !text-[var(--yuri-toast-status-color,var(--muted-foreground))]",
          success: "[&_[data-icon]]:!text-[var(--status-success)]",
          error: "[&_[data-icon]]:!text-[var(--status-error)]",
          warning: "[&_[data-icon]]:!text-[var(--status-warning)]",
          info: "[&_[data-icon]]:!text-[var(--status-info)]",
        },
        style: {
          borderRadius: "var(--radius-xl)",
          backgroundColor: "var(--yuri-toast-background, var(--surface-elevated))",
        },
      }}
      style={
        {
          "--normal-bg": "var(--yuri-toast-background, var(--surface-elevated))",
          "--normal-text": "var(--foreground)",
          "--normal-border": "transparent",
          "--error-bg": "var(--yuri-toast-background, var(--surface-elevated))",
          "--error-text": "var(--foreground)",
          "--error-border": "transparent",
          "--success-bg": "var(--yuri-toast-background, var(--surface-elevated))",
          "--success-text": "var(--foreground)",
          "--success-border": "transparent",
          "--warning-bg": "var(--yuri-toast-background, var(--surface-elevated))",
          "--warning-text": "var(--foreground)",
          "--warning-border": "transparent",
          "--info-bg": "var(--yuri-toast-background, var(--surface-elevated))",
          "--info-text": "var(--foreground)",
          "--info-border": "transparent",
        } as React.CSSProperties
      }
      {...props}
    />
    </div>
  )
}

export { Toaster }
