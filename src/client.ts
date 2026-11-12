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
   * The session the composer belongs to.
   *
   * The tool row is session-scoped, so it knows which conversation a picture
   * should go into; the plugin page is root-scoped and has no session at all.
   * The host hands it over through the slot's own injection, which receives
   * the session it is scoped to.
   */
  sessionId?: string
  /** The composer's own attachment channel, used to fill the input box. */
  inputActions?: {
    addAttachments?: (ids: string[]) => unknown
  }
  /**
   * The host's projection reader, handed to tool-row entries.
   *
   * Absent on hosts that do not offer it; the pill is then kept rather than
   * hidden, so an older host still shows its balance.
   */
  useProjection?: (name: string) => ModelSelection | undefined
}

/**
 * The shape this half needs from the host's sessions service.
 *
 * `binding(id).session.prompt(content, mode, signal, requestId)` is how the
 * composer itself sends a message, so using it puts a generated picture into
 * the conversation by exactly the road a dragged-in picture would take.
 */
interface SessionsContext {
  /** The session's own face, which is how the composer sends a message. */
  binding?: (id: string) => {
    session?: {
      prompt?: (
        content: unknown[],
        mode: string,
        signal?: AbortSignal,
        requestId?: string,
      ) => Promise<unknown>
      /**
       * Registers the local submission echo the host shows for a prompt it
       * accepted. The identity it mints is the one `prompt` must carry.
       */
      beginSubmission?: (input: {
        mode: 'queue' | 'steer'
        text: string
        attachments: unknown[]
      }) => { requestId: string; abandon?: () => void }
    }
  } | undefined
  /** The session's scope, which carries the conversation service. */
  scope?: (id: string) => {
    get?: (key: string) => {
      createDrafts?: (
        sessionId: string,
        files: unknown[],
        uploadImages: boolean,
      ) => { id: string }[]
      releaseDraftAttachments?: (drafts: { id: string }[]) => unknown
    } | undefined
  } | undefined
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
      inject?: (sessionId?: string) => Record<string, unknown>
    }, component: (props: SlotProps) => unknown): unknown
  }
  locale: {
    register(namespace: string, messages: { zh: Record<string, string>; en: Record<string, string> }): unknown
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
  }
  /** The host's sessions service, when it offers one. */
  sessions?: SessionsContext
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
  rateLimit?: {
    state: 'ok' | 'unavailable' | 'expired' | 'signed-out'
    interval?: { usedPercent: number; startAtMs: number; resetAtMs: number }
    weekly?: { usedPercent: number; startAtMs: number; resetAtMs: number }
    updatedAtMs?: number
    reason?: 'no-subscription'
    error?: string
  }
  plan?: {
    active: boolean
    tier?: string
    expiresAtMs?: number
  }
  usageProfile?: {
    state: 'ok' | 'unavailable'
    totalDays?: number
    activeDays?: number
    consecutiveDays?: number
    totalTokenConsumed?: string
    rankingPercent?: number
    mostActiveDay?: { date?: string; tokenCount?: string }
    updatedAt?: string
    error?: string
  }
  generation?: {
    imageModels: string[]
    imageAspectRatios: string[]
    imageAreas: string[]
    videoDurations: number[]
    videoResolutions: string[]
    videoRatios: string[]
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
  const GENERATE_PATH = '/plugins/dsh-connect-minimaxcode/generate'
  const CAPABILITY_PATH = '/plugins/dsh-connect-minimaxcode/capability'
  const POLL_INTERVAL_MS = 20_000
  /**
   * The provider id the host side registers with `llm.registerAdapter`.
   *
   * Duplicated here on purpose: this half is a classic script that cannot
   * import the host's module, and the id is the one the projection reports.
   */
  const MINIMAX_PROVIDER_ID = 'minimaxcode'

  const zh: Record<string, string> = {
    title: 'MiniMax Code',
    balance: '积分 {total}',
    free: '签到积分',
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
    expiringNone: '3 天内没有积分到期',
    expiringSoon: '30 天内到期 {amount} 积分',
    expiring3d: '3天内过期',
    expiringAmount: '{amount} 积分',
    nextExpiry: '最近到期日',
    creditsBox: '积分',
    planTitle: 'Plan 额度',
    usageTitle: '本机用量',
    usageTotal: '累计',
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
    usageWindow: '{duration}限额',
    resetIn: '{duration}后',
    accountUsage: '账户用量',
    usageStreak: '连续使用 {days} 天',
    usageActiveDays: '近 {total} 天中有 {active} 天用过',
    usageTotalTokens: '累计消耗 {count} tokens',
    usageRanking: '用量排名前 {percent}%',
    usageBestDay: '最活跃的一天 {date}',
    planNoSubscription: '未订阅 M Plan（仅积分包），因此没有限额窗口',
    planGeneric: 'M Plan 订阅',
    planExpires: '{date} 到期',
    generateTitle: '生成',
    generateImage: '图片',
    generateVideo: '视频',
    generatePrompt: '描述你想要的画面',
    generateAspect: '画幅',
    generateArea: '清晰度',
    generateDuration: '时长',
    generateResolution: '分辨率',
    generateRatio: '画幅',
    generateRun: '生成',
    generateRunning: '生成中…',
    generateVideoRunning: '视频生成中，约需 1–2 分钟…',
    generateImageDone: '图片已生成',
    generateVideoDone: '视频已生成',
    generateDownload: '下载',
    generateSaved: '已存入 DSH 附件库',
    generateFailed: '生成失败',
    generateHint: '生成走 MiniMax 的开放平台，用的是你账号自己的额度。图片会并存进 DSH 的附件库。',
    generateToChat: '生成图片',
    generateToChatHint: '生成的图片会作为这一轮消息的一部分发给模型。',
    generateSent: '图片已发送到对话',
    generateDrafted: '图片已放入输入框',
    generateSendFailed: '无法发送到对话，请到插件页生成后下载。',
    generateNoSession: '宿主没有给出会话标识，无法定位对话。',
    generateNoSessions: '宿主没有提供会话服务，无法定位对话。',
    generateNoBinding: '当前会话不可达（宿主没有给出它的绑定）。',
    generateNoPrompt: '当前会话不支持发送消息。',
    generateNoDraft: '当前会话不支持草稿附件。',
    generateNoInput: '输入框不接受附件。',
  }
  const en: Record<string, string> = {
    title: 'MiniMax Code',
    balance: '{total} credits',
    free: 'Check-in credits',
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
    expiringNone: 'No credits expire within 3 days',
    expiringSoon: '{amount} credits expire within 30 days',
    expiring3d: 'Expires in 3 days',
    expiringAmount: '{amount} credits',
    nextExpiry: 'Next expiry',
    creditsBox: 'Credits',
    planTitle: 'Plan allowance',
    usageTitle: 'Local usage',
    usageTotal: 'Total',
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
    usageWindow: '{duration} limit',
    resetIn: 'resets in {duration}',
    accountUsage: 'Account usage',
    usageStreak: '{days} days in a row',
    usageActiveDays: 'Used on {active} of the last {total} days',
    usageTotalTokens: '{count} tokens consumed',
    usageRanking: 'Top {percent}% by usage',
    usageBestDay: 'Busiest day {date}',
    planNoSubscription: 'No M Plan subscription (credits only), so there are no usage windows',
    planGeneric: 'M Plan subscription',

    planExpires: 'until {date}',
    generateTitle: 'Generate',
    generateImage: 'Image',
    generateVideo: 'Video',
    generatePrompt: 'Describe what you want',
    generateAspect: 'Aspect',
    generateArea: 'Area',
    generateDuration: 'Length',
    generateResolution: 'Resolution',
    generateRatio: 'Aspect',
    generateRun: 'Generate',
    generateRunning: 'Generating…',
    generateVideoRunning: 'Generating the video, about 1–2 minutes…',
    generateImageDone: 'Image ready',
    generateVideoDone: 'Video ready',
    generateDownload: 'Download',
    generateSaved: 'Saved to DSH attachments',
    generateFailed: 'Generation failed',
    generateHint: 'Generation runs on MiniMax\'s open platform with your own account\'s allowance. Images are also stored in DSH\'s attachment store.',
    generateToChat: 'Generate an image',
    generateToChatHint: 'The generated picture is sent as part of this turn.',
    generateSent: 'The picture is on its way to the conversation',
    generateDrafted: 'The picture is in the input box',
    generateSendFailed: 'Could not send it to the conversation; generate on the plugin page and download it instead.',
    generateNoSession: 'The host named no session, so the conversation cannot be located.',
    generateNoSessions: 'The host offers no sessions service, so the conversation cannot be located.',
    generateNoBinding: 'This session is not reachable (the host gave no binding for it).',
    generateNoPrompt: 'This session cannot send messages.',
    generateNoDraft: 'This session cannot hold draft attachments.',
    generateNoInput: 'The input box does not take attachments.',
  }

  const loader = (globalThis as { __ModuleLoader__?: ModuleLoader }).__ModuleLoader__
  if (loader === undefined) return

  loader.load({
    id: BUNDLE_NAME,
    factory(require: (id: string) => unknown) {
      const React = require('react') as {
        createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown
        useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => void
        useRef: <T>(initial: T) => { current: T }
        useState: <T>(initial: T) => [T, (next: T) => void]
      }
      const h = React.createElement

      /**
       * The host's client context, once the plugin is applied.
       *
       * The components are closures over the module, not over the context, so
       * this is how they reach the host's services.
       */
      let clientContext: SlotContext | undefined

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

      /**
       * The expiry rows, shared by the pill's detail and the page card.
       *
       * The label names the window the count actually covers, and the value
       * carries only the amount: when the lot falls due is the next row's
       * business, not a suffix on this one.
       */
      function expiryRows(t: (key: string, params?: Record<string, unknown>) => string, credits_?: StatusDocument['credits']): unknown[] {
        if (credits_ === undefined) return []
        const expiring = credits_.expiring ?? 0
        const next = credits_.nextExpiryAtMs
        return [
          h('div', { style: rowStyle },
            h('span', null, t('expiring3d')),
            h('span', { style: expiring > 0 ? warnStyle : undefined },
              expiring > 0 ? t('expiringAmount', { amount: credits(expiring, 2) }) : t('expiringNone'))),
          next !== undefined ? row(t('nextExpiry'), day(next)) : null,
        ]
      }

      /**
       * A countdown to a window reset, coarse on purpose: minutes below an
       * hour, hours and minutes below a day, days and hours beyond. It is
       * computed at render time, so it is as fresh as the last status read.
       */
      function countdown(resetAtMs: number): string {
        const minutes = Math.max(0, Math.ceil((resetAtMs - Date.now()) / 60_000))
        if (minutes < 60) return `${minutes}m`
        if (minutes < 1_440) return `${Math.floor(minutes / 60)}h${minutes % 60}m`
        return `${Math.floor(minutes / 1_440)}d${Math.floor((minutes % 1_440) / 60)}h`
      }

      /**
       * The length of a window, as the server defines it.
       *
       * The window's own edges give the length, so the label follows the plan
       * instead of the plan's terms today: five hours today reads "5h", and a
       * plan that moved to a three-hour window reads "3h" without a code
       * change. Only the word around it is translated.
       */
      function windowLabel(window: { startAtMs: number; resetAtMs: number }): string {
        const minutes = Math.max(1, Math.round((window.resetAtMs - window.startAtMs) / 60_000))
        if (minutes >= 1_440) return `${Math.round(minutes / 1_440)}d`
        if (minutes >= 60) {
          const hours = minutes / 60
          return Number.isInteger(hours) ? `${hours}h` : `${Math.floor(hours)}h${minutes % 60}m`
        }
        return `${minutes}m`
      }

      /**
       * The plan's two rolling usage windows, shared by the pill's detail and
       * the page card.
       *
       * The percent sits on the right with the reset countdown in
       * parentheses, and the window length is derived from the window itself
       * rather than written into the label: the plan's terms have changed
       * before, and the display should follow whatever the server says.
       */
      function rateLimitRows(t: (key: string, params?: Record<string, unknown>) => string, rateLimit?: StatusDocument['rateLimit']): unknown[] {
        if (rateLimit === undefined || rateLimit.state !== 'ok') return []
        if (rateLimit.interval === undefined || rateLimit.weekly === undefined) return []
        return [
          row(t('usageWindow', { duration: windowLabel(rateLimit.interval) }), `${rateLimit.interval.usedPercent}%(${t('resetIn', { duration: countdown(rateLimit.interval.resetAtMs) })})`),
          row(t('usageWindow', { duration: windowLabel(rateLimit.weekly) }), `${rateLimit.weekly.usedPercent}%(${t('resetIn', { duration: countdown(rateLimit.weekly.resetAtMs) })})`),
        ]
      }

      /**
       * The account's own usage history, as label lines.
       *
       * This is not the token count of this host — the pill reports that
       * separately — but the account's days, consumption and standing, which
       * is what the upstream knows and nobody else does. It belongs to the
       * page card only, laid out in two columns.
       */
      function usageProfileRows(t: (key: string, params?: Record<string, unknown>) => string, profile?: StatusDocument['usageProfile']): string[] {
        if (profile === undefined || profile.state !== 'ok') return []
        const lines: string[] = []
        if (profile.consecutiveDays !== undefined && profile.consecutiveDays > 0) {
          lines.push(t('usageStreak', { days: profile.consecutiveDays }))
        }
        if (profile.activeDays !== undefined) {
          lines.push(t('usageActiveDays', { active: profile.activeDays, total: profile.totalDays ?? '' }))
        }
        if (profile.totalTokenConsumed !== undefined) {
          lines.push(t('usageTotalTokens', { count: profile.totalTokenConsumed }))
        }
        if (profile.rankingPercent !== undefined) {
          lines.push(t('usageRanking', { percent: profile.rankingPercent.toFixed(1) }))
        }
        if (profile.mostActiveDay?.date !== undefined) {
          lines.push(t('usageBestDay', { date: profile.mostActiveDay.date }))
        }
        return lines
      }

      /**
       * Why there are no usage windows, when there are none because the plan
       * has none to give.
       *
       * The rolling windows belong to the subscription; an account holding
       * only a credit package has none, and saying so is more useful than
       * leaving the reader to wonder whether a read failed.
       */
      function planNotice(t: (key: string, params?: Record<string, unknown>) => string, rateLimit?: StatusDocument['rateLimit']): unknown {
        if (rateLimit?.reason !== 'no-subscription') return null
        return h('div', { style: mutedStyle, 'data-minimax-plan-notice': true }, t('planNoSubscription'))
      }

      /**
       * What the page card's plan box says when it has no windows to show.
       *
       * An empty box would read as "nothing loaded yet" and invite a refresh
       * that cannot help. Every state has a reason worth naming: no sign-in,
       * a stale one, a plan without windows, or a read that failed — the
       * upstream's own message is shown as it arrived, because it is the
       * most specific answer available.
       */
      function rateLimitFallback(t: (key: string, params?: Record<string, unknown>) => string, rateLimit?: StatusDocument['rateLimit']): unknown {
        if (rateLimit === undefined) {
          return h('div', { style: mutedStyle }, t('unavailable'))
        }
        if (rateLimit.reason === 'no-subscription') {
          return h('div', { style: mutedStyle, 'data-minimax-plan-notice': true }, t('planNoSubscription'))
        }
        if (rateLimit.state === 'signed-out') {
          return h('div', { style: mutedStyle }, t('signedOut'))
        }
        if (rateLimit.state === 'expired') {
          return h('div', { style: mutedStyle }, t('expired'))
        }
        if (rateLimit.error !== undefined && rateLimit.error.length > 0) {
          return h('div', { style: mutedStyle }, rateLimit.error)
        }
        return h('div', { style: mutedStyle }, t('unavailable'))
      }

      /**
       * The plan the account holds, when it holds one.
       *
       * An account without a plan has nothing to say here, and the card shows
       * it nothing: the rolling windows it does not have are already
       * explained by the notice beside them. What this adds is for the
       * accounts that do hold one — the tier's name and the day it ends.
       */
      function planLine(t: (key: string, params?: Record<string, unknown>) => string, plan?: StatusDocument['plan']): unknown {
        if (plan === undefined || !plan.active) return null
        const tier = plan.tier ?? t('planGeneric')
        const expiry = plan.expiresAtMs === undefined
          ? null
          : t('planExpires', { date: day(plan.expiresAtMs) })
        return h('div', { style: rowStyle, 'data-minimax-plan': true },
          h('span', null, tier),
          h('span', null, expiry ?? ''),
        )
      }

      /** The pill itself; the gate decides whether it is drawn at all. */
      function CreditPill(props: SlotProps) {
        const [status] = useStatus()
        const [open, setOpen] = React.useState(false)
        // Two ways to open, and they must not fight each other: hovering the
        // pill shows the detail, and a click pins it so it stays after the
        // cursor leaves. A pinned detail closes on the next click — even under
        // the cursor, which is why the click also suppresses the hover that is
        // still in progress until the cursor actually leaves.
        const pinned = React.useRef(false)
        const skipHover = React.useRef(false)
        const t = props.t ?? ((key: string, params?: Record<string, unknown>) => {
          const template = zh[key] ?? key
          return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))
        })

        const credits_ = status?.credits
        const usage = status?.usage
        const rateLimit = status?.rateLimit
        const available = credits_?.state === 'ok' && credits_.total !== undefined
        const windows = rateLimit?.state === 'ok' && rateLimit.interval !== undefined && rateLimit.weekly !== undefined
          ? { interval: rateLimit.interval, weekly: rateLimit.weekly }
          : undefined
        // A window that is used up means the plan cannot serve the next
        // request right now, so the balance is the number worth seeing.
        // Otherwise the pill leads with the short window — the one that gates
        // the next request — named by the length the server gives it. No
        // windows, the balance again: the pill never shows nothing just
        // because one read failed.
        const exhausted = windows !== undefined
          && (windows.interval.usedPercent >= 100 || windows.weekly.usedPercent >= 100)
        const balance = available
          ? t('balance', { total: credits(credits_!.total, 2) })
          : t(credits_?.state === 'expired' ? 'expired' : credits_?.state === 'signed-out' ? 'signedOut' : 'unavailable')
        const label = windows === undefined || exhausted
          ? balance
          : `${windowLabel(windows.interval)}  ${windows.interval.usedPercent}%(${t('resetIn', { duration: countdown(windows.interval.resetAtMs) })})`

        const detail = available
          ? h('div', { style: detailStyle, 'data-minimax-credits-detail': true },
            h('div', { style: detailFlowStyle },
              h('div', { style: boxStyle },
                row(t('free'), credits(credits_!.free, 3)),
                row(t('purchased'), credits(credits_!.purchased, 3)),
                credits_!.consumed !== undefined && credits_!.consumed > 0
                  ? row(t('consumed'), credits(credits_!.consumed, 3))
                  : null,
              ),
              h('div', { style: boxStyle, 'data-minimax-credits-expiry': true },
                ...expiryRows(t, credits_)),
              h('div', { style: boxStyle, 'data-minimax-rate-limit': true },
                ...rateLimitRows(t, status?.rateLimit)),
              usage !== undefined
                ? h('div', { style: boxStyle },
                  row(t('usageTotal'), `${tokens(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens)} tokens(≈¥${money(usage.estimatedCny)})`))
                : null,
              planNotice(t, status?.rateLimit),
              credits_!.updatedAtMs !== undefined
                ? h('div', { style: mutedStyle }, t('updated', { time: new Date(credits_!.updatedAtMs).toLocaleTimeString() }))
                : null,
            ))
          : null

        return h('div', { style: wrapStyle, 'data-minimax-credits': true },
          h('button', {
            type: 'button',
            style: buttonStyle,
            title: t('title'),
            onMouseEnter: () => {
              if (pinned.current || skipHover.current) return
              setOpen(true)
            },
            onMouseLeave: () => {
              skipHover.current = false
              if (!pinned.current) setOpen(false)
            },
            onClick: () => {
              if (pinned.current) {
                pinned.current = false
                skipHover.current = open
                setOpen(false)
              } else {
                pinned.current = true
                setOpen(true)
              }
            },
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

      /**
       * Generate a picture and send it to the conversation.
       *
       * The composer already knows how to send a message with an image in it,
       * and the picture the upstream produces is an ordinary image file, so
       * the dock does the same thing the composer does: it asks the session
       * to accept a turn whose content is the picture plus the prompt.
       *
       * Nothing here is required of the host beyond what the composer itself
       * uses. A host that does not expose the session face simply gets the
       * message that says so, and the plugin page still offers the picture.
       */
      function GenerateDock(props: SlotProps) {
        const t = props.t ?? ((key: string, params?: Record<string, unknown>) => {
          const template = zh[key] ?? key
          return template.replace(/\\{(\\w+)\\}/g, (_match, name: string) => String(params?.[name] ?? ''))
        })
        const [open, setOpen] = React.useState(false)
        /**
         * The session the picture belongs to.
         *
         * The host hands the session id to the slot through its injection,
         * because the slot is session-scoped; it is also carried on the
         * standard props, so either may deliver it. It is read here, before
         * anything else in the dock uses it, because an effect can fire
         * before the rest of the body has run.
         */
        const sessionId = (): string | undefined => props.sessionId

        /**
         * What the host offers this dock, described once.
         *
         * Delivering a picture needs several pieces of the host and they
         * arrive in different ways, so a failure otherwise reads as one
         * undifferentiated message. The report is sent to the plugin's own
         * route, so it can be read from the status document — by whoever is
         * looking at the problem, not only by the person who hit it.
         */
        const reportCapability = (): void => {
          const id = sessionId()
          const services = clientContext?.sessions
          const binding = id === undefined ? undefined : services?.binding?.(id)
          const scoped = id === undefined ? undefined : services?.scope?.(id)
          const conversation = scoped?.get?.('conversation')
          const findings: Record<string, string> = {
            sessionId: id === undefined ? 'missing' : 'present',
            sessionsService: services === undefined ? 'missing' : 'present',
            binding: binding === undefined ? 'missing' : 'present',
            sessionPrompt: typeof binding?.session?.prompt === 'function' ? 'present' : 'missing',
            scope: scoped === undefined ? 'missing' : 'present',
            conversationService: conversation === undefined ? 'missing' : 'present',
            createDrafts: typeof conversation?.createDrafts === 'function' ? 'present' : 'missing',
            inputActions: typeof props.inputActions?.addAttachments === 'function' ? 'present' : 'missing',
          }
          void fetch(`${CAPABILITY_PATH}?report=${encodeURIComponent(JSON.stringify(findings))}`).catch(() => {
            // The report is a courtesy; failing to send it changes nothing.
          })
        }
        React.useEffect(() => {
          reportCapability()
        }, [])

        const [prompt, setPrompt] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [note, setNote] = React.useState('')

        /**
         * The session's own send path.
         *
         * `binding(id).session.prompt(content, mode, signal, requestId)` is
         * what the composer calls when the person presses send, so a picture
         * sent this way is a normal turn.
         *
         * The method is taken off the session object, so it has to be bound to
         * that object before it is called. `prompt` reaches the gateway
         * through `this.remote`, and an unbound call runs with `this` pointing
         * at the wrapper below instead of at the session — which throws
         * `undefined is not an object (evaluating 'this.remote.session')` and
         * leaves the dock reporting that it cannot send the picture.
         */
        const sessionFace = (): {
          prompt: (
            content: unknown[],
            mode: string,
            signal?: AbortSignal,
            requestId?: string,
          ) => Promise<unknown>
          beginSubmission?: (input: {
            mode: 'queue' | 'steer'
            text: string
            attachments: unknown[]
          }) => { requestId: string; abandon?: () => void }
        } | undefined => {
          const id = sessionId()
          if (id === undefined) return undefined
          const binding = clientContext?.sessions?.binding?.(id)
          const session = binding?.session
          const send = session?.prompt
          if (typeof send !== 'function') return undefined
          // `beginSubmission` is taken off the session for the same reason: it
          // is a method of the session and must keep its receiver.
          const begin = session?.beginSubmission
          return {
            prompt: send.bind(session) as typeof send,
            ...(typeof begin === 'function'
              ? { beginSubmission: begin.bind(session) as typeof begin }
              : {}),
          }
        }

        /**
         * The conversation's own draft channel.
         *
         * The composer builds a draft from a browser File and hands its id to
         * the input box, which is how a picture attached by hand appears
         * there. Using the same two steps leaves the picture in the input box
         * for the person to send, rather than sending on their behalf.
         */
        const draftFace = (): {
          createDrafts: (
            sessionId: string,
            files: unknown[],
            uploadImages: boolean,
          ) => { id: string }[]
        } | undefined => {
          const id = sessionId()
          if (id === undefined) return undefined
          const scoped = clientContext?.sessions?.scope?.(id)
          const conversation = scoped?.get?.('conversation')
          const create = conversation?.createDrafts
          return typeof create === 'function'
            ? { createDrafts: create.bind(conversation) as typeof create }
            : undefined
        }

        /** The bytes behind a data URL. */
        const base64Bytes = (dataUrl: string): Uint8Array<ArrayBuffer> => {
          const comma = dataUrl.indexOf(',')
          const base64 = comma < 0 ? dataUrl : dataUrl.slice(comma + 1)
          const binary = atob(base64)
          const bytes = new Uint8Array(new ArrayBuffer(binary.length))
          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index)
          }
          return bytes
        }

        /** Turn a data URL into the parts the session's admission accepts. */
        const imagePart = (dataUrl: string, mediaType: string): { type: string; mediaType: string; data: string } | undefined => {
          const comma = dataUrl.indexOf(',')
          if (comma < 0) return undefined
          return { type: 'image', mediaType, data: dataUrl.slice(comma + 1) }
        }

        async function send(): Promise<void> {
          const text = prompt.trim()
          if (text === '') return
          setBusy(true)
          setNote('')
          try {
            const response = await fetch(GENERATE_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ kind: 'image', prompt: text, area: '1K' }),
            })
            const body = await response.json() as {
              ok?: boolean
              error?: string
              dataUrl?: string
              mediaType?: string
            }
            if (body.ok !== true || body.dataUrl === undefined) {
              setNote(body.error ?? t('generateFailed'))
              return
            }
            const part = imagePart(body.dataUrl, body.mediaType ?? 'image/jpeg')
            if (part === undefined) {
              setNote(t('generateFailed'))
              return
            }
            // Sending the picture as a turn is what the dock promises; the
            // draft channel is the fallback for a host that only offers that.
            const face = sessionFace()
            if (face === undefined) {
              const id = sessionId()
              setNote(
                id === undefined
                  ? t('generateNoSession')
                  : clientContext?.sessions === undefined
                    ? t('generateNoSessions')
                    : t('generateNoBinding'),
              )
            }
            if (face !== undefined) {
              // The host registers a local submission echo before it prompts,
              // and the identity that registration mints is the one the prompt
              // must carry — that is how the sent picture shows up as this
              // turn's message. A made-up identity reaches the model but leaves
              // no echo, so the conversation would not show what was sent.
              const submission = face.beginSubmission?.({
                mode: 'queue',
                text,
                attachments: [],
              })
              const result = await face.prompt(
                [part, { type: 'text', text }],
                'queue',
                undefined,
                submission?.requestId,
              )
              // A refused prompt resolves with `{ ok: false }` rather than
              // throwing, so the outcome has to be read: either way the picture
              // did not arrive.
              if (result === undefined || (result as { ok?: boolean }).ok !== true) {
                setNote(t('generateSendFailed'))
                return
              }
              setPrompt('')
              setOpen(false)
              // The picture's own arrival is the feedback: it is in the
              // conversation now, so the composer needs no banner.
              setNote('')
              return
            }
            const drafts = draftFace()
            const addAttachments = props.inputActions?.addAttachments
            if (drafts === undefined) {
              setNote(
                sessionId() === undefined
                  ? t('generateNoSession')
                  : clientContext?.sessions === undefined
                    ? t('generateNoSessions')
                    : t('generateNoDraft'),
              )
              return
            }
            if (typeof addAttachments !== 'function') {
              setNote(t('generateNoInput'))
              return
            }
            {
              const file = new File(
                [base64Bytes(body.dataUrl)],
                'minimax-h3-image.jpg',
                { type: body.mediaType ?? 'image/jpeg' },
              )
              const created = drafts.createDrafts(sessionId()!, [file], true)
              addAttachments(created.map(draft => draft.id))
              setPrompt('')
              setOpen(false)
              setNote('')
              return
            }
            setNote(t('generateSendFailed'))
          } catch {
            setNote(t('generateSendFailed'))
          } finally {
            setBusy(false)
          }
        }

        if (!open) {
          return h('button', {
            type: 'button',
            style: buttonStyle,
            title: t('generateToChatHint'),
            onClick: () => { setOpen(true); setNote('') },
          }, t('generateToChat'))
        }
        return h('div', { style: dockStyle, 'data-minimax-generate-dock': true },
          h('input', {
            value: prompt,
            placeholder: t('generatePrompt'),
            style: dockInputStyle,
            disabled: busy,
            onChange: (event: { target: { value: string } }) => setPrompt(event.target.value),
          }),
          h('button', {
            type: 'button',
            style: buttonStyle,
            disabled: busy || prompt.trim() === '',
            onClick: () => { void send() },
          }, busy ? t('generateRunning') : t('generateRun')),
          h('button', {
            type: 'button',
            style: buttonStyle,
            disabled: busy,
            onClick: () => { setOpen(false); setPrompt(''); setNote('') },
          }, '✕'),
          note === '' ? null : h('span', { style: mutedStyle }, note),
        )
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
          return h('div', { style: boxStyle, 'data-minimax-login': true },
            row(t('loginTitle'), login.source === 'plugin' ? t('loginPlugin') : t('loginDesktop')),
          )
        }
        if (login.state === 'pending') {
          return h('div', { style: boxStyle, 'data-minimax-login': true },
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
        return h('div', { style: boxStyle, 'data-minimax-login': true },
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
        // The day's status sits at the title's right end: it is a property of
        // the whole block, not of the day-count row below it.
        return h('div', { style: boxStyle, 'data-minimax-signin': true },
          h('div', { style: rowStyle },
            h('span', { style: boxTitleStyle }, t('signinTitle')),
            h('span', { style: mutedStyle },
              signin.today === undefined
                ? t('signinUnavailable')
                : signin.today.claimed
                  ? t('signinClaimed')
                  : signin.today.claimable ? t('signinClaimable') : t('signinUnavailable'))),
          signin.today === undefined
            ? h('div', { style: mutedStyle }, t('signinUnavailable'))
            : h('div', { style: rowStyle },
              h('span', null, t('signinToday', { day: signin.today.dayNo, points: signin.today.points }))),
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
      /**
       * The generation panel.
       *
       * A picture comes back in one answer; a video is a task that takes a
       * minute and a half, so it is polled until the upstream says it is
       * done. The choices come from the server rather than from this half, so
       * they are the ones the upstream actually serves.
       */
      function GenerationPanel(props: SlotProps) {
        const [status] = useStatus()
        const t = props.t ?? ((key: string, params?: Record<string, unknown>) => {
          const template = zh[key] ?? key
          return template.replace(/\\{(\\w+)\\}/g, (_match, name: string) => String(params?.[name] ?? ''))
        })
        const options = status?.generation
        const [mode, setMode] = React.useState<'image' | 'video'>('image')
        const [prompt, setPrompt] = React.useState('')
        const [model, setModel] = React.useState('')
        const [aspect, setAspect] = React.useState('auto')
        const [area, setArea] = React.useState('4K')
        const [duration, setDuration] = React.useState(5)
        const [resolution, setResolution] = React.useState('2K')
        const [ratio, setRatio] = React.useState('16:9')
        const [busy, setBusy] = React.useState(false)
        const [note, setNote] = React.useState('')
        const [picture, setPicture] = React.useState<{ dataUrl: string; size?: string; saved?: boolean } | undefined>(undefined)
        const [video, setVideo] = React.useState<{ url: string; status?: string } | undefined>(undefined)

        const imageModels = options?.imageModels ?? ['MiniMax-H3-Image']

        /** Ask for a picture; the answer carries the bytes inline. */
        async function makeImage(): Promise<void> {
          setBusy(true)
          setNote('')
          setVideo(undefined)
          try {
            const response = await fetch(GENERATE_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                kind: 'image',
                prompt,
                model: model === '' ? undefined : model,
                aspectRatio: aspect,
                area,
              }),
            })
            const body = await response.json() as {
              ok?: boolean
              error?: string
              dataUrl?: string
              size?: string
              attachment?: { attachmentId?: string }
            }
            if (body.ok !== true || body.dataUrl === undefined) {
              setNote(body.error ?? t('generateFailed'))
              return
            }
            setPicture({ dataUrl: body.dataUrl, size: body.size, saved: body.attachment !== undefined })
          } catch {
            setNote(t('generateFailed'))
          } finally {
            setBusy(false)
          }
        }

        /** Start a video task, then wait for it the way the upstream does. */
        async function makeVideo(): Promise<void> {
          setBusy(true)
          setNote('')
          setPicture(undefined)
          try {
            const response = await fetch(GENERATE_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                kind: 'video',
                prompt,
                duration,
                resolution,
                ratio,
              }),
            })
            const body = await response.json() as { ok?: boolean; error?: string; taskId?: string }
            if (body.ok !== true || body.taskId === undefined) {
              setNote(body.error ?? t('generateFailed'))
              return
            }
            // The task takes a minute and a half; the upstream is asked every
            // ten seconds, the way its own documentation recommends.
            for (let attempt = 0; attempt < 60; attempt += 1) {
              await new Promise(resolve => setTimeout(resolve, 10000))
              const polled = await fetch(`${GENERATE_PATH}?taskId=${encodeURIComponent(body.taskId)}`)
              const task = await polled.json() as { status?: string; url?: string; error?: string }
              if (task.url !== undefined) {
                setVideo({ url: task.url, status: task.status })
                setNote('')
                return
              }
              if (task.status !== undefined && /fail|cancel/i.test(task.status)) {
                setNote(task.error ?? t('generateFailed'))
                return
              }
            }
            setNote(t('generateFailed'))
          } catch {
            setNote(t('generateFailed'))
          } finally {
            setBusy(false)
          }
        }

        const select = (value: string, onChange: (next: string) => void, values: string[]) =>
          h('select', {
            value,
            style: selectStyle,
            onChange: (event: { target: { value: string } }) => onChange(event.target.value),
          }, ...values.map(option => h('option', { key: option, value: option }, option)))

        return h('div', { style: genCardStyle, 'data-minimax-generation': true },
          h('div', { style: cardTitleStyle }, t('generateTitle')),
          h('div', { style: rowStyle },
            h('button', {
              type: 'button',
              style: mode === 'image' ? tabActiveStyle : actionButtonStyle,
              onClick: () => { setMode('image'); setPicture(undefined); setVideo(undefined) },
            }, t('generateImage')),
            h('button', {
              type: 'button',
              style: mode === 'video' ? tabActiveStyle : actionButtonStyle,
              onClick: () => { setMode('video'); setPicture(undefined); setVideo(undefined) },
            }, t('generateVideo'))),
          h('textarea', {
            value: prompt,
            placeholder: t('generatePrompt'),
            style: promptStyle,
            rows: 3,
            onChange: (event: { target: { value: string } }) => setPrompt(event.target.value),
          }),
          mode === 'image'
            ? h('div', { style: rowStyle },
              select(model === '' ? imageModels[0]! : model, setModel, imageModels),
              select(aspect, setAspect, options?.imageAspectRatios ?? ['auto', '16:9', '1:1']),
              select(area, setArea, options?.imageAreas ?? ['1K', '2K', '4K']))
            : h('div', { style: rowStyle },
              select(String(duration), next => setDuration(Number(next)), (options?.videoDurations ?? [5, 10]).map(String)),
              select(resolution, setResolution, options?.videoResolutions ?? ['768P', '2K']),
              select(ratio, setRatio, options?.videoRatios ?? ['16:9', '9:16'])),
          h('div', { style: rowStyle },
            h('button', {
              type: 'button',
              style: actionButtonStyle,
              disabled: busy || prompt.trim() === '',
              onClick: () => { void (mode === 'image' ? makeImage() : makeVideo()) },
            }, busy ? (mode === 'video' ? t('generateVideoRunning') : t('generateRunning')) : t('generateRun'))),
          note === '' ? null : h('div', { style: mutedStyle }, note),
          picture === undefined
            ? null
            : h('div', { style: generationResultStyle, 'data-minimax-generation-image': true },
              h('img', { src: picture.dataUrl, alt: prompt, style: generatedImageStyle }),
              h('div', { style: rowStyle },
                h('span', null, picture.size === undefined ? t('generateImageDone') : `${t('generateImageDone')} · ${picture.size}`),
                picture.saved === true ? h('span', null, t('generateSaved')) : null,
                h('a', { href: picture.dataUrl, download: 'minimax-h3-image.jpg', style: linkStyle }, t('generateDownload')))),
          video === undefined
            ? null
            : h('div', { style: generationResultStyle, 'data-minimax-generation-video': true },
              h('video', { src: video.url, controls: true, style: generatedVideoStyle }),
              h('div', { style: rowStyle },
                h('span', null, t('generateVideoDone')),
                h('a', { href: video.url, download: 'minimax-h3-video.mp4', style: linkStyle }, t('generateDownload')))),
          h('div', { style: mutedStyle }, t('generateHint')),
        )
      }

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
          return h('div', { style: pageStyle, 'data-minimax-page': true },
            h('div', { style: cardStyle, 'data-minimax-credits-card': true },
              h('div', { style: cardTitleStyle }, t('title')),
              h('div', { style: rowStyle },
                h('span', null, t('unavailable')),
                h('span', null, credits_?.state === 'expired' ? t('expired') : '')),
              loginBlock(t, login, refresh),
            ),
            // The generation panel does not need the balance: it spends the
            // account's generation allowance, not its credits, so it stays
            // usable even when the balance cannot be read.
            h(GenerationPanel, props),
          )
        }

        // The page's rows of hairline sections are gone: the card now reads as
        // a two-column grid of soft sub-cards. Row one is the balance and the
        // plan's windows, row two the check-in cycle and the next grants due,
        // row three this host's own usage across both columns, row four the
        // account's usage history across both.
        const lots = [...(credits_!.upcoming ?? [])].sort((a, b) => a.expireAtMs - b.expireAtMs)
        const windows = rateLimitRows(t, status?.rateLimit)
        const profileLines = usageProfileRows(t, status?.usageProfile)
        const updated = credits_!.updatedAtMs !== undefined
          ? t('updated', { time: new Date(credits_!.updatedAtMs).toLocaleTimeString() })
          : undefined
        const loginLine = login?.state === 'signed-in'
          ? (login.source === 'plugin' ? t('loginPlugin') : t('loginDesktop'))
          : undefined
        return h('div', { style: pageStyle, 'data-minimax-page': true },
          h('div', { style: cardStyle, 'data-minimax-credits-card': true },
            h('div', { style: cardHeadStyle },
              h('span', { style: cardTitleStyle }, t('title')),
              h('span', { style: mutedStyle },
                [loginLine, updated].filter(line => line !== undefined).join(' · '))),
            h('div', { style: gridStyle },
              h('div', { style: boxStyle },
                h('div', { style: boxTitleStyle }, t('creditsBox')),
                h('div', { style: bigNumberStyle }, credits(credits_!.total, 2)),
                row(t('free'), credits(credits_!.free, 3)),
                row(t('purchased'), credits(credits_!.purchased, 3)),
                ...expiryRows(t, credits_).slice(0, 1)),
              h('div', { style: boxStyle, 'data-minimax-rate-limit': true },
                h('div', { style: boxTitleStyle }, t('planTitle')),
                ...(windows.length > 0
                  ? [
                      // The invisible number keeps the windows lined up with
                      // the balance box's rows, which sit below its own big
                      // number. With no windows to align, it is only noise.
                      h('div', { style: { ...bigNumberStyle, visibility: 'hidden' as const }, 'aria-hidden': 'true' }, '—'),
                      ...windows,
                    ]
                  : [rateLimitFallback(t, status?.rateLimit)])),
              // The tier and the day it ends, for an account that holds one.
              // An account without a plan has nothing to say here.
              planLine(t, status?.plan),
              signinBlock(t, signin, refresh),
              h('div', { style: boxStyle },
                h('div', { style: boxTitleStyle }, t('lots')),
                // The upstream already caps the list at the five soonest lots
                // with credits left; the sort only keeps that promise honest.
                ...(lots.length === 0
                  ? [h('div', { style: mutedStyle }, t('noLots'))]
                  : lots.map((lot, index) =>
                    h('div', { key: `${lot.expireAtMs}-${index}`, style: rowStyle },
                      h('span', null, day(lot.expireAtMs)),
                      h('span', null, credits(lot.amount, 2)))))),
              usage !== undefined
                ? h('div', { style: { ...boxStyle, ...span2Style }, 'data-minimax-usage': true },
                  h('div', { style: boxTitleStyle }, t('usageTitle')),
                  row(t('usageTotal'), `${tokens(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens)} tokens(≈¥${money(usage.estimatedCny)})`),
                  usage.requests > 0 ? row(t('requests', { count: usage.requests }), usage.lastModel ?? '') : null,
                )
                : null,
              profileLines.length > 0
                ? h('div', { style: { ...boxStyle, ...span2Style }, 'data-minimax-usage-profile': true },
                  h('div', { style: boxTitleStyle }, t('accountUsage')),
                  h('div', { style: profileGridStyle },
                    ...profileLines.map((line, index) => h('div', { key: `profile-${index}` }, line))))
                : null,
              login !== undefined && login.state !== 'signed-in'
                ? h('div', { style: span2Style }, loginBlock(t, login, refresh))
                : null,
            ),
          ),
          // The generation panel does not need the balance: it spends the
          // account's generation allowance, not its credits, so it stays
          // usable even when the balance cannot be read.
          h(GenerationPanel, props),
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
      const dockStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
      }
      const dockInputStyle = {
        width: '160px',
        padding: '2px 6px',
        borderRadius: '999px',
        border: '1px solid var(--dsh-composer-dock-inset, currentColor)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
      }
      const detailStyle = {
        position: 'absolute' as const,
        bottom: 'calc(100% + 6px)',
        left: 0,
        zIndex: 10,
        minWidth: '260px',
        borderRadius: '14px',
        background: 'var(--dsh-panel-background, Canvas)',
        color: 'var(--dsh-panel-foreground, CanvasText)',
        border: '1px solid var(--dsh-panel-border, currentColor)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
        padding: '10px',
        fontSize: '12px',
        lineHeight: 1.6,
        textAlign: 'left' as const,
      }
      const rowStyle = {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '16px',
      }
      // The rounded sub-card every section of the detail and the page card
      // lives in. The fill is a translucent gray so one value works on both
      // themes; the host's own muted token wins when it offers one.
      const boxStyle = {
        background: 'var(--dsh-muted, rgba(127, 127, 127, 0.1))',
        borderRadius: '10px',
        padding: '7px 10px',
        display: 'flex',
        flexDirection: 'column' as const,
        gap: '4px',
      }
      const boxTitleStyle = { fontWeight: 600, fontSize: '12px', opacity: 0.85 }
      const detailFlowStyle = { display: 'flex', flexDirection: 'column' as const, gap: '6px' }
      const warnStyle = { color: 'var(--dsh-warning, #b45309)' }
      const cardStyle = {
        display: 'flex',
        flexDirection: 'column' as const,
        gap: '8px',
        fontSize: '13px',
        lineHeight: 1.6,
        background: 'var(--dsh-panel-background, Canvas)',
        border: '1px solid var(--dsh-panel-border, currentColor)',
        borderRadius: '14px',
        padding: '12px',
      }
      const cardHeadStyle = {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: '8px',
        flexWrap: 'wrap' as const,
      }
      // The page card's two-column grid: credits beside the plan, the check-in
      // beside the grants, and the wide rows spanning both columns below.
      const gridStyle = {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: '8px',
      }
      const span2Style = { gridColumn: '1 / -1' }
      // The account usage box lays its lines out two across.
      const profileGridStyle = {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: '4px 16px',
      }
      // The page stacks the balance card and the generation panel.
      const pageStyle = {
        display: 'flex',
        flexDirection: 'column' as const,
        gap: '10px',
      }
      // The generation panel wears the same rounded shell as the balance
      // card, so the page reads as a stack of two cards rather than a card
      // above a bare section.
      const genCardStyle = {
        display: 'flex',
        flexDirection: 'column' as const,
        gap: '8px',
        fontSize: '13px',
        lineHeight: 1.6,
        background: 'var(--dsh-panel-background, Canvas)',
        border: '1px solid var(--dsh-panel-border, currentColor)',
        borderRadius: '14px',
        padding: '12px',
      }
      const cardTitleStyle = { fontWeight: 600 }
      const bigNumberStyle = { fontSize: '20px', fontWeight: 600, marginBottom: '2px' }
      const mutedStyle = { opacity: 0.7, fontSize: '12px' }
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

      const tabActiveStyle = {
        appearance: 'none',
        padding: '2px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-panel-border, currentColor)',
        background: 'var(--dsh-panel-bg, transparent)',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        fontWeight: 600,
      }
      const promptStyle = {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-panel-border, currentColor)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        resize: 'vertical',
      }
      const selectStyle = {
        padding: '2px 4px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-panel-border, currentColor)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      }
      const generationResultStyle = {
        marginTop: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }
      const generatedImageStyle = {
        maxWidth: '100%',
        borderRadius: '8px',
        border: '1px solid var(--dsh-panel-border, currentColor)',
      }
      const generatedVideoStyle = {
        maxWidth: '100%',
        borderRadius: '8px',
      }

      return {
        // The sessions service is what lets a generated picture be delivered
        // into the conversation the composer belongs to.
        inject: ['slots', 'locale', 'sessions'],
        apply(ctx: unknown) {
          const context = ctx as SlotContext
          // The components need the host's sessions service to deliver a
          // generated picture into the conversation, so it is kept where the
          // components can reach it.
          clientContext = context
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
          // The image dock sits beside the balance: it is the same provider's
          // capability, and it needs the session the composer belongs to.
          context.slots.inject('conversation.input.left', () => context.slots.register({
            name: 'conversation.input.left',
            id: 'minimax-generate',
            order: 5,
            locale: NAMESPACE,
            // The slot is session-scoped, and its injection receives the
            // session it is scoped to — which is how the dock learns which
            // conversation a picture belongs to.
            inject: (sessionId?: string) => ({ t, sessionId }),
          }, GenerateDock))
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
