/**
 * The browser half: the credit balance, in the composer and on the page.
 *
 * The host loads a client bundle as a classic script and calls
 * `window.__ModuleLoader__.load`, handing the factory a `require` that
 * resolves against the browser's own module table. React therefore comes from
 * the host — this file installs no React of its own, and ships no bundler
 * output: it is a script, so it can be dropped into the page as-is.
 *
 * Two surfaces read the same data: a pill in the composer's dock, and a card
 * on the plugin's own page. Both read it through one store with one ticker,
 * so the account API is asked once per interval no matter how many surfaces
 * are on screen.
 */

/** The host's module loader, as the desktop app's own bundles use it. */
interface ModuleLoader {
  load(config: { id: string; factory(require: (id: string) => unknown): unknown }): void
}

/** What the host's model-selection projection reports. */
interface ModelSelection {
  /** The selection the next request will use, when the picker has written one. */
  next?: { provider?: string }
  /** The selection the previous request used, before `next` was written. */
  lastUsed?: { provider?: string }
}

/** The props the host's slots hand to a registered component. */
interface SlotProps {
  t?: (key: string, params?: Record<string, unknown>) => string
  view?: 'summary' | 'page'
  /**
   * The host's projection reader, handed to tool-row entries.
   *
   * Absent on hosts that do not offer it; the pill is then kept rather than
   * hidden, so an older host still shows its balance.
   */
  useProjection?: (name: string) => ModelSelection | undefined
}

/** The shape this half needs from the host's slot registry. */
interface SlotContext {
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(options: {
      name: string
      id?: string
      key?: string
      order?: number
      locale?: string
      /**
       * Extra props the host hands to the component.
       *
       * The composer and plugin-page slots do not carry a translator in
       * their standard props, so the bound locale is injected here.
       */
      inject?: () => Record<string, unknown>
    }, component: (props: SlotProps) => unknown): unknown
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
    expiring?: number
    expiringLots?: number
    expiringSoon?: number
    nextExpiryAtMs?: number
    upcoming?: { amount: number; expireAtMs: number }[]
    ledgerAtMs?: number
    ledgerError?: string
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
  signin?: {
    state: 'ok' | 'unavailable'
    today?: { dayNo: number; points: number; status: number; claimable: boolean; claimed: boolean }
    days?: { dayNo: number; points: number; status: number; isToday: boolean }[]
    cyclePoints?: number
    autoCheckin: boolean
    lastClaimDay?: string
    lastClaimAtMs?: number
    lastClaimPoints?: number
    lastClaimResult?: number
    error?: string
  }
  login?: {
    state: 'signed-in' | 'signed-out' | 'pending'
    source?: 'plugin' | 'desktop-app'
    userCode?: string
    verificationUri?: string
    verificationUriComplete?: string
    expiresAtMs?: number
  }
}

;(function bootstrapMinimaxCodeClient(): void {
  const BUNDLE_NAME = 'dsh-connect-minimaxcode'
  const NAMESPACE = 'dsh-connect-minimaxcode'
  const STATUS_PATH = '/plugins/dsh-connect-minimaxcode/status'
  const ACTION_PATH = '/plugins/dsh-connect-minimaxcode/action'
  const POLL_INTERVAL_MS = 20_000
  /**
   * The provider id the host side registers with `llm.registerAdapter`.
   *
   * Duplicated here on purpose: this half is a classic script that cannot
   * import the host's module, and the id is the one the projection reports.
   */
  const MINIMAX_PROVIDER_ID = 'minimaxcode'

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
    expiring: '即将过期',
    expiringIn: '{amount} 积分 · {date} 到期',
    expiringNone: '7 天内没有积分到期',
    expiringSoon: '30 天内到期 {amount} 积分',
    nextExpiry: '最近到期日',
    lots: '到期批次',
    noLots: '没有待到期的积分批次',
    loginTitle: '登录',
    loginPlugin: '已在插件内登录',
    loginDesktop: '使用 MiniMax Code 桌面 App 的登录态',
    loginSignedOut: '未登录',
    loginPending: '等待你在浏览器里确认',
    loginCode: '设备码',
    loginOpen: '打开授权页面',
    loginPolled: '我已授权，检查一下',
    loginStart: '登录 MiniMax Code',
    signinTitle: '每日签到',
    signinToday: '第 {day} 天 · {points} 积分',
    signinClaimed: '今日已签到',
    signinClaimable: '今日可签到',
    signinUnavailable: '签到信息不可用',
    signinCycle: '一轮共 {points} 积分',
    signinLast: '上次签到 {day}，{points} 积分',
    signinAuto: '每天自动签到',
    signinClaim: '签到',
    claimableToday: '今日可签到',
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
    expiring: 'Expiring soon',
    expiringIn: '{amount} credits · expires {date}',
    expiringNone: 'No credits expire within 7 days',
    expiringSoon: '{amount} credits expire within 30 days',
    nextExpiry: 'Next expiry',
    lots: 'Expiring grants',
    noLots: 'No grant is waiting to expire',
    loginTitle: 'Sign-in',
    loginPlugin: 'Signed in through the plugin',
    loginDesktop: 'Using the MiniMax Code desktop app sign-in',
    loginSignedOut: 'Not signed in',
    loginPending: 'Waiting for you to confirm in the browser',
    loginCode: 'Device code',
    loginOpen: 'Open the authorization page',
    loginPolled: 'I authorized it — check',
    loginStart: 'Sign in to MiniMax Code',
    signinTitle: 'Daily check-in',
    signinToday: 'Day {day} · {points} credits',
    signinClaimed: 'Claimed today',
    signinClaimable: 'Claimable today',
    signinUnavailable: 'Check-in information unavailable',
    signinCycle: '{points} credits per cycle',
    signinLast: 'Last claim on {day}, {points} credits',
    signinAuto: 'Claim daily on its own',
    signinClaim: 'Claim',
    claimableToday: 'Claimable today',
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

      /** Format a date as a short day. */
      function day(value: number | undefined): string {
        if (value === undefined) return '—'
        const date = new Date(value)
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      }

      /**
       * The shared status store.
       *
       * One ticker serves every surface, so a second surface costs no extra
       * request. The store starts when the first surface subscribes and stops
       * when the last one leaves.
       */
      const listeners = new Set<(status: StatusDocument | undefined) => void>()
      let snapshot: StatusDocument | undefined
      let timer: ReturnType<typeof setInterval> | undefined

      async function load(): Promise<void> {
        try {
          const response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
          if (!response.ok) return
          const document = await response.json() as StatusDocument
          snapshot = document
          for (const listener of listeners) listener(snapshot)
        } catch {
          // Keep the last value: a failed poll is not worth a blank pill.
        }
      }

      function subscribe(listener: (status: StatusDocument | undefined) => void): () => void {
        listeners.add(listener)
        if (listeners.size === 1) {
          void load()
          timer = setInterval(() => { void load() }, POLL_INTERVAL_MS)
        }
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0 && timer !== undefined) {
            clearInterval(timer)
            timer = undefined
          }
        }
      }

      /** Read the shared status into a component's state. */
      function useStatus(): [StatusDocument | undefined, () => void] {
        const [status, setStatus] = React.useState<StatusDocument | undefined>(undefined)
        React.useEffect(() => subscribe(setStatus), [])
        return [status, () => { void load() }]
      }

      /** A row of label and value. */
      function row(label: string, value: string): unknown {
        return h('div', { style: rowStyle }, h('span', null, label), h('span', null, value))
      }

      /** The expiry block, shared by the pill's detail and the page card. */
      function expiryBlock(t: (key: string, params?: Record<string, unknown>) => string, credits_?: StatusDocument['credits']): unknown {
        if (credits_ === undefined) return null
        const expiring = credits_.expiring ?? 0
        const next = credits_.nextExpiryAtMs
        return h('div', { style: expiryBoxStyle, 'data-minimax-credits-expiry': true },
          h('div', { style: rowStyle },
            h('span', null, t('expiring')),
            h('span', { style: expiring > 0 ? warnStyle : undefined },
              expiring > 0
                ? t('expiringIn', { amount: credits(expiring, 2), date: day(next) })
                : t('expiringNone')),
          ),
          credits_.expiringSoon !== undefined && credits_.expiringSoon > 0
            ? row(t('expiringSoon', { amount: credits(credits_.expiringSoon, 2) }), '')
            : null,
          next !== undefined ? row(t('nextExpiry'), day(next)) : null,
        )
      }

      /** The pill itself; the gate decides whether it is drawn at all. */
      function CreditPill(props: SlotProps) {
        const [status] = useStatus()
        const [open, setOpen] = React.useState(false)
        const t = props.t ?? ((key: string, params?: Record<string, unknown>) => {
          const template = zh[key] ?? key
          return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))
        })

        const credits_ = status?.credits
        const usage = status?.usage
        const available = credits_?.state === 'ok' && credits_.total !== undefined
        const label = available
          ? t('balance', { total: credits(credits_!.total, 2) })
          : t(credits_?.state === 'expired' ? 'expired' : credits_?.state === 'signed-out' ? 'signedOut' : 'unavailable')

        const detail = available
          ? h('div', { style: detailStyle, 'data-minimax-credits-detail': true },
            row(t('free'), credits(credits_!.free, 3)),
            row(t('purchased'), credits(credits_!.purchased, 3)),
            credits_!.consumed !== undefined && credits_!.consumed > 0
              ? row(t('consumed'), credits(credits_!.consumed, 3))
              : null,
            expiryBlock(t, credits_),
            usage !== undefined
              ? h('div', { style: rowStyle },
                h('span', null, t('tokens', { count: tokens(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens) })),
                h('span', null, t('cost', { amount: money(usage.estimatedCny) })))
              : null,
            credits_!.updatedAtMs !== undefined
              ? row(t('updated', { time: new Date(credits_!.updatedAtMs).toLocaleTimeString() }), '')
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

      /**
       * The pill, only while this plugin's own provider is selected.
       *
       * The balance belongs to the provider the next request will actually
       * use, so another connector's model means this balance is the wrong
       * number to show: the gate hides the readout and — because the pill is
       * the only subscriber — the polling stops with it. The projection comes
       * from the host's own `modelSelection`, which is what the model picker
       * writes, so the readout cannot disagree with the model in effect.
       *
       * A host without the projection, or a session where the picker has not
       * chosen yet, keeps the pill: "I do not know" must not hide a balance
       * that is true either way.
       */
      function CreditPillGate(props: SlotProps) {
        const projection = props.useProjection?.('modelSelection')
        const provider = (projection?.next ?? projection?.lastUsed)?.provider
        if (provider !== undefined && provider !== MINIMAX_PROVIDER_ID) return null
        return h(CreditPill, props)
      }

      /** Ask the host to do something, and let the card read the result. */
      async function act(action: string, body?: Record<string, unknown>): Promise<void> {
        try {
          await fetch(`${ACTION_PATH}?action=${encodeURIComponent(action)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          })
        } catch {
          // The card shows the state the host reports; a failed request is
          // reported there too.
        }
        // Read the state the host produced, so the card shows what happened.
        void load()
      }

      /**
       * The sign-in block.
       *
       * The plugin can sign in on its own: the person authorizes in their own
       * browser, and the plugin never sees a password. When the desktop app
       * is already signed in, that credential is used and this block says so.
       */
      function loginBlock(
        t: (key: string, params?: Record<string, unknown>) => string,
        login: StatusDocument['login'],
        refresh: () => void,
      ): unknown {
        if (login === undefined) return null
        if (login.state === 'signed-in') {
          return h('div', { style: sectionBoxStyle, 'data-minimax-login': true },
            row(t('loginTitle'), login.source === 'plugin' ? t('loginPlugin') : t('loginDesktop')),
          )
        }
        if (login.state === 'pending') {
          return h('div', { style: sectionBoxStyle, 'data-minimax-login': true },
            row(t('loginTitle'), t('loginPending')),
            login.userCode !== undefined && login.userCode.length > 0
              ? row(t('loginCode'), login.userCode)
              : null,
            login.verificationUriComplete !== undefined && login.verificationUriComplete.length > 0
              ? h('a', {
                  href: login.verificationUriComplete,
                  target: '_blank',
                  rel: 'noreferrer',
                  style: linkStyle,
                }, t('loginOpen'))
              : null,
            h('button', { type: 'button', style: actionButtonStyle, onClick: () => { void act('login-poll') } }, t('loginPolled')),
          )
        }
        return h('div', { style: sectionBoxStyle, 'data-minimax-login': true },
          row(t('loginTitle'), t('loginSignedOut')),
          h('button', { type: 'button', style: actionButtonStyle, onClick: () => { void act('login-start') } }, t('loginStart')),
        )
      }

      /**
       * The check-in block.
       *
       * The cycle is seven days; the card shows which day it is and what the
       * day is worth, and lets the person claim it — or leave it to the
       * plugin, once a day, and only when the server says the day can be
       * claimed.
       */
      function signinBlock(
        t: (key: string, params?: Record<string, unknown>) => string,
        signin: StatusDocument['signin'],
        refresh: () => void,
      ): unknown {
        if (signin === undefined) return null
        return h('div', { style: sectionBoxStyle, 'data-minimax-signin': true },
          h('div', { style: sectionTitleStyle }, t('signinTitle')),
          signin.today === undefined
            ? h('div', { style: mutedStyle }, t('signinUnavailable'))
            : h('div', { style: rowStyle },
              h('span', null, t('signinToday', { day: signin.today.dayNo, points: signin.today.points })),
              h('span', null, signin.today.claimed ? t('signinClaimed') : signin.today.claimable ? t('signinClaimable') : t('signinUnavailable'))),
          (signin.days ?? []).length === 0
            ? null
            : h('div', { style: dayRowStyle },
              ...(signin.days ?? []).map(day_ =>
                h('span', {
                  key: `day-${day_.dayNo}`,
                  title: `${day_.dayNo}: ${day_.points}`,
                  style: {
                    ...dayDotStyle,
                    ...day_.isToday ? dayTodayStyle : {},
                    ...day_.status === 3 ? dayClaimedStyle : {},
                  },
                }, String(day_.dayNo)))),
          signin.cyclePoints !== undefined
            ? h('div', { style: mutedStyle }, t('signinCycle', { points: signin.cyclePoints }))
            : null,
          signin.lastClaimDay !== undefined
            ? h('div', { style: mutedStyle }, t('signinLast', { day: signin.lastClaimDay, points: signin.lastClaimPoints ?? 0 }))
            : null,
          h('div', { style: rowStyle },
            h('label', { style: checkboxStyle },
              h('input', {
                type: 'checkbox',
                checked: signin.autoCheckin === true,
                onChange: (event: { target?: { checked?: boolean } }) => {
                  void act('settings', { autoCheckin: event.target?.checked === true })
                },
              }),
              h('span', null, t('signinAuto'))),
            signin.today?.claimable === true
              ? h('button', { type: 'button', style: actionButtonStyle, onClick: () => { void act('claim') } }, t('signinClaim'))
              : null,
          ),
          signin.error !== undefined ? h('div', { style: mutedStyle }, signin.error) : null,
        )
      }

      /**
       * The card on the plugin's own page.
       *
       * The summary view is the one line the plugin list shows; the page view
       * is the full card, where the expiry detail belongs.
       */
      function PluginPage(props: SlotProps) {
        const [status, refresh] = useStatus()
        const t = props.t ?? ((key: string, params?: Record<string, unknown>) => {
          const template = zh[key] ?? key
          return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))
        })
        const credits_ = status?.credits
        const usage = status?.usage
        const signin = status?.signin
        const login = status?.login
        const available = credits_?.state === 'ok' && credits_.total !== undefined

        if (props.view === 'summary') {
          if (!available) return h('span', null, t('unavailable'))
          return h('span', { 'data-minimax-credits-summary': true },
            t('balance', { total: credits(credits_!.total, 2) }),
            credits_!.expiring !== undefined && credits_!.expiring > 0
              ? ` · ${t('expiringIn', { amount: credits(credits_!.expiring, 2), date: day(credits_!.nextExpiryAtMs) })}`
              : '',
            signin?.today?.claimable === true ? ` · ${t('claimableToday')}` : '',
          )
        }

        if (!available) {
          return h('div', { style: cardStyle, 'data-minimax-credits-card': true },
            h('div', { style: cardTitleStyle }, t('title')),
            h('div', { style: rowStyle },
              h('span', null, t('unavailable')),
              h('span', null, credits_?.state === 'expired' ? t('expired') : '')),
            loginBlock(t, login, refresh),
          )
        }

        return h('div', { style: cardStyle, 'data-minimax-credits-card': true },
          h('div', { style: cardTitleStyle }, t('title')),
          h('div', { style: bigNumberStyle }, t('balance', { total: credits(credits_!.total, 2) })),
          row(t('free'), credits(credits_!.free, 3)),
          row(t('purchased'), credits(credits_!.purchased, 3)),
          expiryBlock(t, credits_),
          signinBlock(t, signin, refresh),
          h('div', { style: sectionTitleStyle }, t('lots')),
          (credits_!.upcoming ?? []).length === 0
            ? h('div', { style: mutedStyle }, t('noLots'))
            : h('ul', { style: listStyle },
              ...(credits_!.upcoming ?? []).map((lot, index) =>
                h('li', { key: `${lot.expireAtMs}-${index}`, style: rowStyle },
                  h('span', null, day(lot.expireAtMs)),
                  h('span', null, credits(lot.amount, 2)),
                ))),
          usage !== undefined
            ? h('div', { style: usageBoxStyle },
              row(t('tokens', { count: tokens(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens) }), ''),
              row(t('cost', { amount: money(usage.estimatedCny) }), ''),
              usage.requests > 0 ? row(t('requests', { count: usage.requests }), usage.lastModel ?? '') : null,
            )
            : null,
          loginBlock(t, login, refresh),
          credits_!.updatedAtMs !== undefined
            ? h('div', { style: mutedStyle }, t('updated', { time: new Date(credits_!.updatedAtMs).toLocaleTimeString() }))
            : null,
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
        minWidth: '240px',
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
      const rowStyle = {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '16px',
      }
      const expiryBoxStyle = {
        marginTop: '6px',
        paddingTop: '6px',
        borderTop: '1px solid var(--dsh-panel-border, currentColor)',
        opacity: 0.95,
      }
      const warnStyle = { color: 'var(--dsh-warning, #b45309)' }
      const cardStyle = {
        display: 'flex',
        flexDirection: 'column' as const,
        gap: '6px',
        fontSize: '13px',
        lineHeight: 1.6,
      }
      const cardTitleStyle = { fontWeight: 600 }
      const bigNumberStyle = { fontSize: '20px', fontWeight: 600, marginBottom: '2px' }
      const sectionTitleStyle = { marginTop: '8px', fontWeight: 600 }
      const mutedStyle = { opacity: 0.7, fontSize: '12px' }
      const listStyle = { listStyle: 'none', margin: 0, padding: 0 }
      const sectionBoxStyle = {
        marginTop: '10px',
        paddingTop: '8px',
        borderTop: '1px solid var(--dsh-panel-border, currentColor)',
        display: 'flex',
        flexDirection: 'column' as const,
        gap: '6px',
      }
      const actionButtonStyle = {
        appearance: 'none' as const,
        background: 'transparent',
        border: '1px solid var(--dsh-panel-border, currentColor)',
        borderRadius: '6px',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
        padding: '2px 10px',
        width: 'fit-content',
      }
      const linkStyle = { color: 'inherit', fontSize: '12px' }
      const checkboxStyle = { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }
      const dayRowStyle = { display: 'flex', gap: '6px', flexWrap: 'wrap' as const }
      const dayDotStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '22px',
        height: '22px',
        borderRadius: '999px',
        border: '1px solid var(--dsh-panel-border, currentColor)',
        fontSize: '11px',
        opacity: 0.6,
      }
      const dayTodayStyle = { opacity: 1, fontWeight: 600 }
      const dayClaimedStyle = { background: 'var(--dsh-panel-border, currentColor)', opacity: 0.9 }
      const usageBoxStyle = {
        marginTop: '8px',
        paddingTop: '6px',
        borderTop: '1px solid var(--dsh-panel-border, currentColor)',
        opacity: 0.9,
      }

      return {
        inject: ['slots', 'locale'],
        apply(ctx: unknown) {
          const context = ctx as SlotContext
          // Visible text goes through the host's locale service.
          context.effect(() => context.locale.register(NAMESPACE, { zh, en }), `${BUNDLE_NAME}: locale`)
          // The composer and plugin-page slots carry no translator in their
          // standard props, so the bound one is injected into both. Without
          // this the components fall back to their own Chinese copy and an
          // English host shows Chinese labels.
          const t = context.locale.bind(NAMESPACE)
          // The tool row to the left of the composer — beside the model
          // picker — rather than the ambient strip below it: the balance
          // belongs to the provider that is selected, so it sits where that
          // selection is made, and the gate hides it when another connector's
          // model is in effect.
          context.slots.inject('conversation.input.left', () => context.slots.register({
            name: 'conversation.input.left',
            id: 'minimax-credits',
            order: 4,
            locale: NAMESPACE,
            inject: () => ({ t }),
          }, CreditPillGate))
          // The plugin's own page, keyed by the package name, where the
          // balance and the expiry schedule are spelled out.
          context.slots.inject('plugins.bundle.config', () => context.slots.register({
            name: 'plugins.bundle.config',
            key: BUNDLE_NAME,
            locale: NAMESPACE,
            inject: () => ({ t }),
          }, PluginPage))
        },
      }
    },
  })
})()
