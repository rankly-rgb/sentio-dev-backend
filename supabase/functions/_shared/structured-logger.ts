export interface LogContext {
  correlation_id: string
  organization_id?: string
  function_name: string
  provider?: string
}

function log(level: string, ctx: LogContext, message: string, extra?: Record<string, unknown>) {
  const entry = {
    level,
    timestamp: new Date().toISOString(),
    correlation_id: ctx.correlation_id,
    organization_id: ctx.organization_id ?? null,
    function_name: ctx.function_name,
    provider: ctx.provider ?? null,
    message,
    ...extra,
  }
  if (level === 'error') console.error(JSON.stringify(entry))
  else if (level === 'warn') console.warn(JSON.stringify(entry))
  else console.log(JSON.stringify(entry))
}

export function createLogger(ctx: LogContext) {
  return {
    info: (msg: string, extra?: Record<string, unknown>) => log('info', ctx, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => log('warn', ctx, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => log('error', ctx, msg, extra),
  }
}
