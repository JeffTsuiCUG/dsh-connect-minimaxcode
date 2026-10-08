/**
 * The settings card's browser half.
 *
 * Renders the sign-in state, how long the token has left, and the model list.
 * It holds no secret: the document it renders is the secret-free one the host
 * produces, and the token never crosses into the browser.
 *
 * @module dsh-connect-minimaxcode/client
 */

import React from 'react'
import { MINIMAX_STATUS_PATH, type StatusDocument } from '../src/status-route.ts'

export { MINIMAX_STATUS_PATH }
export type { StatusDocument }

/** Colour by expiry state, so "about to expire" cannot read as healthy. */
function expiryColor(expiry: StatusDocument['expiry']): string {
  switch (expiry) {
    case 'expired':
      return '#dc2626'
    case 'expiring':
      return '#d97706'
    default:
      return '#16a34a'
  }
}

/** The headline a user should act on. */
function headline(doc: StatusDocument): string {
  if (doc.state === 'expired') return '登录令牌已过期'
  if (doc.state === 'signed-out') return '未检测到登录信息'
  return '已登录'
}

/** One-line explanation beneath the headline. */
function subtitle(doc: StatusDocument): string {
  if (doc.state === 'signed-in') {
    const days = doc.daysRemaining
    const remaining = days === undefined ? '' : days <= 0 ? '（今日到期）' : `（剩余约 ${days} 天）`
    return `MiniMax Code · 国内版${remaining}`
  }
  return doc.hint ?? ''
}

/** The model list, or the reason there is none. */
function ModelList({ doc }: { doc: StatusDocument }): React.ReactElement {
  if (doc.state !== 'signed-in') return <p className="dim">登录后即可在模型选择器中使用。</p>
  if (doc.models === undefined || doc.models.length === 0) return <p className="dim">正在获取模型列表…</p>
  return (
    <ul className="mmx-models">
      {doc.models.map((model) => (
        <li key={model.id}>
          <span className="mmx-model-name">{model.name}</span>
          <span className="mmx-model-id">{model.id}</span>
          <span className="mmx-model-ctx">{Math.round(model.contextWindow / 1000)}k</span>
        </li>
      ))}
    </ul>
  )
}

/** The whole card. */
export function MinimaxCodeCard(): React.ReactElement {
  const [doc, setDoc] = React.useState<StatusDocument | undefined>(undefined)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch(MINIMAX_STATUS_PATH)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const next = (await response.json()) as StatusDocument
        if (!cancelled) {
          setDoc(next)
          setFailed(false)
        }
      } catch {
        if (!cancelled) setFailed(true)
      }
    }
    void load()
    // The host recomposes the catalog on its own schedule; poll slowly and
    // only while the card is open, so an idle session costs nothing.
    const timer = setInterval(() => void load(), 60_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (failed) return <p className="dim">无法读取插件状态。</p>
  if (doc === undefined) return <p className="dim">正在读取状态…</p>

  return (
    <section className="mmx-card">
      <header className="mmx-card-head">
        <span className="mmx-dot" style={{ background: expiryColor(doc.state === 'signed-in' ? doc.expiry : 'expired') }} />
        <strong>{headline(doc)}</strong>
        {doc.refreshing === true && <span className="dim"> · 刷新中…</span>}
      </header>
      <p className="mmx-sub">{subtitle(doc)}</p>
      {doc.catalogError !== undefined && (
        <p className="mmx-warn">模型列表获取失败，正在使用内置列表（{doc.catalogError}）</p>
      )}
      <ModelList doc={doc} />
      <footer className="mmx-card-foot dim">
        令牌由 MiniMax Code 桌面 App 管理，本插件不会自动登录或续期。过期后请在 App 中重新登录并重启 DSH。
      </footer>
    </section>
  )
}

export default MinimaxCodeCard