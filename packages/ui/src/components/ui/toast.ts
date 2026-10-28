"use client"

import { isValidElement } from "react"
import { toast as sonnerToast } from "sonner"
import type { ExternalToast } from "sonner"
import { copyTextToClipboard } from '@/lib/clipboard'
import { triggerMobileHaptic } from '@/hooks/streamingHaptics'

const copyToClipboard = async (text: string) => {
  const result = await copyTextToClipboard(text)
  if (!result.ok) {
    console.error('Failed to copy to clipboard:', result.error)
  }
}

const reactNodeToText = (value: unknown): string => {
  if (value == null || typeof value === "boolean") {
    return ""
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value.map(reactNodeToText).join(" ").trim()
  }
  if (isValidElement(value)) {
    const element = value as React.ReactElement<{ children?: React.ReactNode }>
    return reactNodeToText(element.props?.children)
  }
  return ""
}

const resolveToastDescription = (description: ExternalToast["description"]): React.ReactNode => {
  if (typeof description === "function") {
    return description()
  }
  return description
}

const getToastCopyText = (message: Parameters<typeof sonnerToast.error>[0], data?: ExternalToast): string => {
  const descriptionText = reactNodeToText(resolveToastDescription(data?.description))
  if (descriptionText.length > 0) {
    return descriptionText
  }
  return reactNodeToText(message)
}

// Wrapper to automatically add OK button to success and info toasts, Copy button to error and warning toasts
export const toast: typeof sonnerToast = Object.assign(
  (...args: Parameters<typeof sonnerToast>) => {
    triggerMobileHaptic()
    return sonnerToast(...args)
  },
  {
  ...sonnerToast,
  success: (...args: Parameters<typeof sonnerToast.success>) => {
    const [message, data] = args
    triggerMobileHaptic()
    return sonnerToast.success(message, {
      ...data,
      action: data?.action || {
        label: 'OK',
        onClick: () => {},
      },
    })
  },
  info: (...args: Parameters<typeof sonnerToast.info>) => {
    const [message, data] = args
    triggerMobileHaptic()
    return sonnerToast.info(message, {
      ...data,
      action: data?.action || {
        label: 'OK',
        onClick: () => {},
      },
    })
  },
  error: (...args: Parameters<typeof sonnerToast.error>) => {
    const [message, data] = args
    triggerMobileHaptic()
    return sonnerToast.error(message, {
      duration: 5000,
      ...data,
      action: data?.action || {
        label: 'Copy',
        onClick: () => copyToClipboard(getToastCopyText(message, data)),
      },
    })
  },
  warning: (...args: Parameters<typeof sonnerToast.warning>) => {
    const [message, data] = args
    triggerMobileHaptic()
    return sonnerToast.warning(message, {
      duration: 5000,
      ...data,
      action: data?.action || {
        label: 'Copy',
        onClick: () => copyToClipboard(getToastCopyText(message, data)),
      },
    })
  },
  loading: (...args: Parameters<typeof sonnerToast.loading>) => {
    triggerMobileHaptic()
    return sonnerToast.loading(...args)
  },
  custom: (...args: Parameters<typeof sonnerToast.custom>) => {
    triggerMobileHaptic()
    return sonnerToast.custom(...args)
  },
  promise: <ToastData,>(...args: Parameters<typeof sonnerToast.promise<ToastData>>) => {
    triggerMobileHaptic()
    return sonnerToast.promise<ToastData>(...args)
  },
  },
)
