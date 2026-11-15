// The usage reading for a local Alfred engine, in the shape its status line script sends. Pure, no engine.

/** At most one reading per session in this long, as the old status line script sent it. */
export const ALFRED_EVERY_MS = 60_000

export type AlfredInput = {
  configDir: string
  session: string
  model: string
  limits: ReadonlyArray<{ kind: string; percentUsed: number; resetsAt?: string }>
  context: { tokens?: number; window: number; percent?: number }
}

type Window = { used_percentage: number; resets_at?: number }

/**
 * The body of `POST /api/konta/uzycie`: the account's config folder, the
 * session id, each usage window (percent used, reset in Unix seconds), the
 * model id and the context window. Never the e-mail, never a credential,
 * never anything said in the session. Null when there is nothing to report.
 */
export const alfredBody = (a: AlfredInput) => {
  const rate: Record<string, Window> = {}
  for (const l of a.limits) {
    if (!Number.isFinite(l.percentUsed)) continue
    const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    rate[l.kind] = { used_percentage: l.percentUsed, ...(Number.isNaN(at) ? {} : { resets_at: Math.floor(at / 1000) }) }
  }
  const hasContext = typeof a.context.percent === 'number'
  if (Object.keys(rate).length === 0 && !hasContext) return null
  return {
    zrodlo: 'statusline',
    klient: 'cache-meter',
    config_dir: a.configDir,
    sesja: a.session,
    model: a.model,
    rate_limits: rate,
    context_window: {
      used_percentage: a.context.percent ?? null,
      context_window_size: a.context.window || null,
      total_input_tokens: a.context.tokens ?? null,
    },
  }
}

/** `~/x` and `$HOME/x` under the person's home. */
export const homePath = (p: string, home: string | undefined): string =>
  p.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, (home ?? '').replace(/\/+$/, ''))
