"use strict";
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
;
(function bootstrapMinimaxCodeClient() {
    const BUNDLE_NAME = 'dsh-connect-minimaxcode';
    const NAMESPACE = 'dsh-connect-minimaxcode';
    const STATUS_PATH = '/plugins/dsh-connect-minimaxcode/status';
    const POLL_INTERVAL_MS = 20000;
    const zh = {
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
        nextExpiry: '最近一笔到期',
        lots: '到期批次',
        noLots: '没有待到期的积分批次',
    };
    const en = {
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
    };
    const loader = globalThis.__ModuleLoader__;
    if (loader === undefined)
        return;
    loader.load({
        id: BUNDLE_NAME,
        factory(require) {
            const React = require('react');
            const h = React.createElement;
            /** Format a credit amount without pretending to more precision. */
            function credits(value, digits) {
                if (value === undefined || !Number.isFinite(value))
                    return '—';
                return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
            }
            /** Format a token count compactly. */
            function tokens(value) {
                if (!Number.isFinite(value))
                    return '—';
                if (value < 1000)
                    return String(value);
                if (value < 1000000)
                    return `${(value / 1000).toFixed(1)}k`;
                return `${(value / 1000000).toFixed(2)}M`;
            }
            /** Format a small amount of money. */
            function money(value) {
                if (value === undefined || !Number.isFinite(value))
                    return '—';
                if (value === 0)
                    return '0';
                if (value < 0.01)
                    return value.toFixed(4);
                return value.toFixed(2);
            }
            /** Format a date as a short day. */
            function day(value) {
                if (value === undefined)
                    return '—';
                const date = new Date(value);
                return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            }
            /**
             * The shared status store.
             *
             * One ticker serves every surface, so a second surface costs no extra
             * request. The store starts when the first surface subscribes and stops
             * when the last one leaves.
             */
            const listeners = new Set();
            let snapshot;
            let timer;
            async function load() {
                try {
                    const response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } });
                    if (!response.ok)
                        return;
                    const document = await response.json();
                    snapshot = document;
                    for (const listener of listeners)
                        listener(snapshot);
                }
                catch {
                    // Keep the last value: a failed poll is not worth a blank pill.
                }
            }
            function subscribe(listener) {
                listeners.add(listener);
                if (listeners.size === 1) {
                    void load();
                    timer = setInterval(() => { void load(); }, POLL_INTERVAL_MS);
                }
                return () => {
                    listeners.delete(listener);
                    if (listeners.size === 0 && timer !== undefined) {
                        clearInterval(timer);
                        timer = undefined;
                    }
                };
            }
            /** Read the shared status into a component's state. */
            function useStatus() {
                const [status, setStatus] = React.useState(undefined);
                React.useEffect(() => subscribe(setStatus), []);
                return status;
            }
            /** A row of label and value. */
            function row(label, value) {
                return h('div', { style: rowStyle }, h('span', null, label), h('span', null, value));
            }
            /** The expiry block, shared by the pill's detail and the page card. */
            function expiryBlock(t, credits_) {
                if (credits_ === undefined)
                    return null;
                const expiring = credits_.expiring ?? 0;
                const next = credits_.nextExpiryAtMs;
                return h('div', { style: expiryBoxStyle, 'data-minimax-credits-expiry': true }, h('div', { style: rowStyle }, h('span', null, t('expiring')), h('span', { style: expiring > 0 ? warnStyle : undefined }, expiring > 0
                    ? t('expiringIn', { amount: credits(expiring, 2), date: day(next) })
                    : t('expiringNone'))), credits_.expiringSoon !== undefined && credits_.expiringSoon > 0
                    ? row(t('expiringSoon', { amount: credits(credits_.expiringSoon, 2) }), '')
                    : null, next !== undefined ? row(t('nextExpiry'), day(next)) : null);
            }
            /** The pill in the composer's dock. */
            function CreditPill(props) {
                const status = useStatus();
                const [open, setOpen] = React.useState(false);
                const t = props.t ?? ((key, params) => {
                    const template = zh[key] ?? key;
                    return template.replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? ''));
                });
                const credits_ = status?.credits;
                const usage = status?.usage;
                const available = credits_?.state === 'ok' && credits_.total !== undefined;
                const label = available
                    ? t('balance', { total: credits(credits_.total, 2) })
                    : t(credits_?.state === 'expired' ? 'expired' : credits_?.state === 'signed-out' ? 'signedOut' : 'unavailable');
                const detail = available
                    ? h('div', { style: detailStyle, 'data-minimax-credits-detail': true }, row(t('free'), credits(credits_.free, 3)), row(t('purchased'), credits(credits_.purchased, 3)), credits_.consumed !== undefined && credits_.consumed > 0
                        ? row(t('consumed'), credits(credits_.consumed, 3))
                        : null, expiryBlock(t, credits_), usage !== undefined
                        ? h('div', { style: rowStyle }, h('span', null, t('tokens', { count: tokens(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens) })), h('span', null, t('cost', { amount: money(usage.estimatedCny) })))
                        : null, credits_.updatedAtMs !== undefined
                        ? row(t('updated', { time: new Date(credits_.updatedAtMs).toLocaleTimeString() }), '')
                        : null)
                    : null;
                return h('div', { style: wrapStyle, 'data-minimax-credits': true }, h('button', {
                    type: 'button',
                    style: buttonStyle,
                    title: t('title'),
                    onClick: () => setOpen(!open),
                }, label), open ? detail : null);
            }
            /**
             * The card on the plugin's own page.
             *
             * The summary view is the one line the plugin list shows; the page view
             * is the full card, where the expiry detail belongs.
             */
            function PluginPage(props) {
                const status = useStatus();
                const t = props.t ?? ((key, params) => {
                    const template = zh[key] ?? key;
                    return template.replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? ''));
                });
                const credits_ = status?.credits;
                const usage = status?.usage;
                const available = credits_?.state === 'ok' && credits_.total !== undefined;
                if (props.view === 'summary') {
                    if (!available)
                        return h('span', null, t('unavailable'));
                    return h('span', { 'data-minimax-credits-summary': true }, t('balance', { total: credits(credits_.total, 2) }), credits_.expiring !== undefined && credits_.expiring > 0
                        ? ` · ${t('expiringIn', { amount: credits(credits_.expiring, 2), date: day(credits_.nextExpiryAtMs) })}`
                        : '');
                }
                if (!available) {
                    return h('div', { style: cardStyle, 'data-minimax-credits-card': true }, h('div', { style: cardTitleStyle }, t('title')), h('div', { style: rowStyle }, h('span', null, t('unavailable')), h('span', null, credits_?.state === 'expired' ? t('expired') : '')));
                }
                return h('div', { style: cardStyle, 'data-minimax-credits-card': true }, h('div', { style: cardTitleStyle }, t('title')), h('div', { style: bigNumberStyle }, t('balance', { total: credits(credits_.total, 2) })), row(t('free'), credits(credits_.free, 3)), row(t('purchased'), credits(credits_.purchased, 3)), expiryBlock(t, credits_), h('div', { style: sectionTitleStyle }, t('lots')), (credits_.upcoming ?? []).length === 0
                    ? h('div', { style: mutedStyle }, t('noLots'))
                    : h('ul', { style: listStyle }, ...(credits_.upcoming ?? []).map((lot, index) => h('li', { key: `${lot.expireAtMs}-${index}`, style: rowStyle }, h('span', null, day(lot.expireAtMs)), h('span', null, credits(lot.amount, 2))))), usage !== undefined
                    ? h('div', { style: usageBoxStyle }, row(t('tokens', { count: tokens(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens) }), ''), row(t('cost', { amount: money(usage.estimatedCny) }), ''), usage.requests > 0 ? row(t('requests', { count: usage.requests }), usage.lastModel ?? '') : null)
                    : null, credits_.updatedAtMs !== undefined
                    ? h('div', { style: mutedStyle }, t('updated', { time: new Date(credits_.updatedAtMs).toLocaleTimeString() }))
                    : null);
            }
            const wrapStyle = {
                position: 'relative',
                display: 'inline-flex',
                alignItems: 'center',
            };
            const buttonStyle = {
                appearance: 'none',
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
            };
            const detailStyle = {
                position: 'absolute',
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
                textAlign: 'left',
            };
            const rowStyle = {
                display: 'flex',
                justifyContent: 'space-between',
                gap: '16px',
            };
            const expiryBoxStyle = {
                marginTop: '6px',
                paddingTop: '6px',
                borderTop: '1px solid var(--dsh-panel-border, currentColor)',
                opacity: 0.95,
            };
            const warnStyle = { color: 'var(--dsh-warning, #b45309)' };
            const cardStyle = {
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                fontSize: '13px',
                lineHeight: 1.6,
            };
            const cardTitleStyle = { fontWeight: 600 };
            const bigNumberStyle = { fontSize: '20px', fontWeight: 600, marginBottom: '2px' };
            const sectionTitleStyle = { marginTop: '8px', fontWeight: 600 };
            const mutedStyle = { opacity: 0.7, fontSize: '12px' };
            const listStyle = { listStyle: 'none', margin: 0, padding: 0 };
            const usageBoxStyle = {
                marginTop: '8px',
                paddingTop: '6px',
                borderTop: '1px solid var(--dsh-panel-border, currentColor)',
                opacity: 0.9,
            };
            return {
                inject: ['slots', 'locale'],
                apply(ctx) {
                    const context = ctx;
                    // Visible text goes through the host's locale service.
                    context.effect(() => context.locale.register(NAMESPACE, { zh, en }), `${BUNDLE_NAME}: locale`);
                    // The composer dock is the strip under the input box, which is where
                    // the host itself renders its activity and usage pills.
                    context.slots.inject('conversation.composer.dock', () => context.slots.register({
                        name: 'conversation.composer.dock',
                        id: 'minimax-credits',
                        order: 2,
                        locale: NAMESPACE,
                    }, CreditPill));
                    // The plugin's own page, keyed by the package name, where the
                    // balance and the expiry schedule are spelled out.
                    context.slots.inject('plugins.bundle.config', () => context.slots.register({
                        name: 'plugins.bundle.config',
                        key: BUNDLE_NAME,
                        locale: NAMESPACE,
                    }, PluginPage));
                },
            };
        },
    });
})();
