'use client'

// TEMP DEBUG — Global error catcher for freeze diagnosis
// Remove this entire file once the root cause is identified

import { type ReactElement, useEffect } from 'react'

function logDebug(payload: Record<string, unknown>) {
  console.error('[SENTIO_DEBUG]', {
    ...payload,
    timestamp: new Date().toISOString(),
    url: window.location.href,
  })
}

export function GlobalErrorCatcher(): ReactElement | null {
  useEffect(() => {
    // --- Unhandled promise rejections ---
    function onUnhandledRejection(event: PromiseRejectionEvent) {
      const error = event.reason
      logDebug({
        type: 'unhandled_rejection',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
    }

    // --- Uncaught errors not caught by React boundaries ---
    function onError(event: ErrorEvent) {
      logDebug({
        type: 'uncaught_error',
        message: event.message,
        stack: event.error?.stack,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      })
    }

    window.addEventListener('unhandledrejection', onUnhandledRejection)
    window.addEventListener('error', onError)

    // --- Long task detection (UI freezes > 50ms) ---
    let longTaskObserver: PerformanceObserver | null = null
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > 50) {
              logDebug({
                type: 'long_task',
                duration_ms: Math.round(entry.duration),
                startTime_ms: Math.round(entry.startTime),
              })
            }
          }
        })
        longTaskObserver.observe({ entryTypes: ['longtask'] })
      } catch {
        // longtask not supported in this browser — skip silently
      }
    }

    return () => {
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
      window.removeEventListener('error', onError)
      longTaskObserver?.disconnect()
    }
  }, [])

  return null
}
