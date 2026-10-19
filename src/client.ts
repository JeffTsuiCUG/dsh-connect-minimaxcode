/**
 * The browser half: a credit pill in the composer's dock.
 *
 * The host loads a client bundle as a classic script and calls
 * `window.__ModuleLoader__.load`, handing the factory a `require` that
 * resolves against the browser's own module table. React therefore comes from
 * the host — this file installs no React of its own, and ships no bundler
 * output: it is a script, so it can be dropped into the page as-is.
 *
 * The pill shows the account's remaining credits and what this host's
 * conversations have used, both read from the plugin's own status route. It
 * degrades quietly: a failed read keeps the last value rather than blanking
 * the dock.
 */

/** The host's module loader, as the desktop app's own bundles use it. */
interface ModuleLoader {
  load(config: { id: string; factory(require: (id: string) => unknown): unknown }): void
}

/** The shape this half needs from the host's slot registry. */
interface SlotContext {
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(options: {
      name: string
      id?: string
      order?: number
      locale?: string
    }, component: (props: { t?: (key: string, params?: Record<string, unknown>) => string }) => unknown): unknown
  }
  locale: {
    register(namespace: string, messages: { zh: Record<string, string>; en: Record<string, string> }): unknown
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
  }
  effect(effect: () => unknown, label?: string): unknown
}

/** The plugin's own status document, as far as this half reads it. */
interface StatusDocument {
  credits?: {
    state: 'ok' | 'unavailable' | 'expired' | 'signed-out'
    total?: number
    purchased?: number
    free?: number
    consumed?: number
    updatedAtMs?: number
    error?: string
  }
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    estimatedCny: number
    lastCny?: number
    lastModel?: string
    requests: number
  }
}

;(function bootstrapMinimaxCodeClient(): void {
  const BUNDLE_NAME = 'dsh-connect-minimaxcode'
  const NAMESPACE = 'dsh-connect-minimaxcode'
  const STATUS_PATH = '/plugins/dsh-connect-minimaxcode/status'
  const POLL_INTERVAL_MS = 20_000

  const zh: Record<string, string> = {
    title: 'MiniMax Code 积分',
    balance: '积分 {total}',
    free: '赠送积分',
    purchased: '购买积分',
    consumed: '上次读取后消耗',
    tokens: '本机累计 {count} tokens',
    cost: '等效金额 ≈ ¥{amount}',
    requests: '{count} 次请求',
    updated: '更新于 {time}',
    unavailable: '积分不可用',
    expired: '登录态已过期',
    signedOut: '未登录 MiniMax Code',
    close: '收起',
  }
  const en: Record<string, string> = {
    title: 'MiniMax Code credits',
    balance: '{total} credits',
    free: 'Free credits',
    purchased: 'Purchased credits',
    consumed: 'Spent since last read',
    tokens: '{count} tokens used here',
    cost: 'Equivalent ≈ ¥{amount}',
    requests: '{count} requests',
    updated: 'Updated {time}',
    unavailable: 'Credits unavailable',
    expired: 'Sign-in expired',
    signedOut: 'MiniMax Code not signed in',
    close: 'Hide',
  }

  const loader = (globalThis as { __ModuleLoader__?: ModuleLoader }).__ModuleLoader__
  if (loader === undefined) return

  loader.load({
    id: BUNDLE_NAME,
    factory(require: (id: string) => unknown) {
      const React = require('react') as {
        createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown
        useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => void
        useState: <T>(initial: T) => [T, (next: T) => void]
      }
      const h = React.createElement

      /** Format a credit amount without pretending to more precision. */
      function credits(value: number | undefined, digits: number): string {
        if (value === undefined || !Number.isFinite(value)) return '—'
        return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 })
      }

      /** Format a token count compactly. */
      function tokens(value: number): string {
        if (!Number.isFinite(value)) return '—'
        if (value < 1000) return String(value)
        if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
        return `${(value / 1_000_000).toFixed(2)}M`
      }

      /** Format a small amount of money. */
      function money(value: number | undefined): string {
        if (value === undefined || !Number.isFinite(value)) return '—'
        if (value === 0) return '0'
        if (value < 0.01) return value.toFixed(4)
        return value.toFixed(2)
      }

      /** The pill, plus the detail panel it opens. */
      function CreditPill(props: { t?: (key: string, params?: Record<string, unknown>) => string }) {
        const [status, setStatus] = React.useState<StatusDocument | undefined>(undefined)
        const [open, setOpen] = React.useState(false)

        // `t` comes from the host's locale service when the slot declares the
        // namespace; the built-in copy is the fallback for a host that does not.
        const t = props.t ?? ((key: string, params?: Record<string, unknown>) => {
          const template = zh[key] ?? key
          return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))
        })

        React.useEffect(() => {
          let cancelled = false
          const load = async (): Promise<void> => {
            try {
              const response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
              if (!response.ok) return
              const document = await response.json() as StatusDocument
              if (!cancelled) setStatus(document)
            } catch {
              // Keep the last value: a failed poll is not worth a blank pill.
            }
          }
          void load()
          const timer = setInterval(() => { void load() }, POLL_INTERVAL_MS)
          return () => {
            cancelled = true
            clearInterval(timer)
          }
        }, [])

        const credits_ = status?.credits
        const usage = status?.usage
        const available = credits_?.state === 'ok' && credits_.total !== undefined

        const label = available
          ? t('balance', { total: credits(credits_!.total, 2) })
          : t(credits_?.state === 'expired' ? 'expired' : credits_?.state === 'signed-out' ? 'signedOut' : 'unavailable')

        const detail = available
          ? h('div', { style: detailStyle, 'data-minimax-credits-detail': true },
            h('div', { style: detailRowStyle }, h('span', null, t('free')), h('span', null, credits(credits_!.free, 3))),
            h('div', { style: detailRowStyle }, h('span', null, t('purchased')), h('span', null, credits(credits_!.purchased, 3))),
            credits_!.consumed !== undefined && credits_!.consumed > 0
              ? h('div', { style: detailRowStyle }, h('span', null, t('consumed')), h('span', null, credits(credits_!.consumed, 3)))
              : null,
            usage !== undefined
              ? h('div', { style: detailRowStyle }, h('span', null, t('tokens', { count: tokens(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens) })), h('span', null, t('cost', { amount: money(usage.estimatedCny) })))
              : null,
            usage !== undefined && usage.requests > 0
              ? h('div', { style: detailRowStyle }, h('span', null, t('requests', { count: usage.requests })), h('span', null, usage.lastModel ?? ''))
              : null,
            credits_!.updatedAtMs !== undefined
              ? h('div', { style: detailRowStyle }, h('span', null, t('updated', { time: new Date(credits_!.updatedAtMs).toLocaleTimeString() })), h('span', null, ''))
              : null,
          )
          : null

        return h('div', { style: wrapStyle, 'data-minimax-credits': true },
          h('button', {
            type: 'button',
            style: buttonStyle,
            title: t('title'),
            onClick: () => setOpen(!open),
          }, label),
          open ? detail : null,
        )
      }

      const wrapStyle = {
        position: 'relative' as const,
        display: 'inline-flex',
        alignItems: 'center',
      }
      const buttonStyle = {
        appearance: 'none' as const,
        background: 'transparent',
        border: '1px solid var(--dsh-composer-dock-inset, currentColor)',
        borderRadius: '999px',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1.4,
        opacity: 0.8,
        padding: '1px 8px',
      }
      const detailStyle = {
        position: 'absolute' as const,
        bottom: 'calc(100% + 6px)',
        left: 0,
        zIndex: 10,
        minWidth: '220px',
        borderRadius: '8px',
        background: 'var(--dsh-panel-background, Canvas)',
        color: 'var(--dsh-panel-foreground, CanvasText)',
        border: '1px solid var(--dsh-panel-border, currentColor)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
        padding: '8px 10px',
        fontSize: '12px',
        lineHeight: 1.6,
        textAlign: 'left' as const,
      }
      const detailRowStyle = {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '16px',
      }

      return {
        inject: ['slots', 'locale'],
        apply(ctx: unknown) {
          const context = ctx as SlotContext
          // Visible text goes through the host's locale service.
          context.effect(() => context.locale.register(NAMESPACE, { zh, en }), `${BUNDLE_NAME}: locale`)
          // The composer dock is the strip under the input box, which is where
          // the host itself renders its activity and usage pills.
          context.slots.inject('conversation.composer.dock', () => context.slots.register({
            name: 'conversation.composer.dock',
            id: 'minimax-credits',
            order: 2,
            locale: NAMESPACE,
          }, CreditPill))
        },
      }
    },
  })
})()
