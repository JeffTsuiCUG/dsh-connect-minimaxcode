# The account endpoints

The upstream surfaces this plugin reads about the account, as measured on
**2026-11-12** (and re-measured on **2026-11-15** against a subscribed
account) in the **China** region.

## The membership answer

```
POST https://agent.minimax.cn/matrix/api/v1/commerce/get_membership_info
Authorization: Bearer <the desktop app's OAuth token>
Content-Type: application/json
Body: {}
```

The answer is the one place several facts arrive together:

| Field | Meaning |
| --- | --- |
| `op_credit_summary.total_remaining_amount` | the balance, free plus purchased |
| `op_credit_summary.purchased_remaining_amount` | the purchased part |
| `op_credit_summary.free_remaining_amount` | the granted part |
| `has_token_plan` | whether the account holds a plan |
| `token_plan_tier` | the plan's name, e.g. `Go` |
| `token_plan_expires_at` | when the plan ends, in milliseconds |
| `subscription_type` | `mplan` once a plan is held, `none` before |
| `opcredit_balance`, `total_remains_credit` | the older, flat view |

**The flat fields are a legacy view.** On an account that has migrated to the
credit pool they read zero even though credits remain, so the plugin uses
them only when the summary is absent altogether.

**A plan's tier is the upstream's own value.** `token_plan_tier` said `Go`
for the account measured here; another plan would say its own name. Only an
answer without that field falls back to a generic label.

## The plan's limit windows

```
GET https://api.minimax.cn/v1/token_plan/remains
Authorization: Bearer <the open-platform key>
```

**The field names and their meaning changed.** Before a plan was held the
answer carried `current_interval_used_percent` and
`current_weekly_used_percent` as strings (`"19%"`). With a plan it carries
`current_interval_remaining_percent` and `current_weekly_remaining_percent`
as plain numbers (`90`) — the *remaining* share, under a name that says so.

Both shapes are accepted, and what leaves the plugin is always the share
**used**: 92% remaining is 8% used. The window length is taken from the
answer's own edges rather than from the plan's terms, because the terms have
changed before: the measured answer is a five-hour window and a 168-hour one.

A window the upstream marks as unlimited (`current_*_status` of 3) carries no
allowance to be a percentage of, so it produces no window at all.

**An account without a plan gets `2062 no active token plan subscription`**
rather than an answer. That is the difference between "no windows" and "the
read failed", and the plugin tells them apart.

## The credit ledger

```
GET https://agent.minimax.cn/minimax-cloud/api/v1/credit/details?page_number=1&page_size=20
```

The answer's `details[]` carry `expire_at_ms` and the remaining amount. The
upstream's lots expire **day by day, spread over thirty-odd days**, so the
plugin's "expiring soon" window is a display choice, not something the
upstream states.

The credit-package summary lives at:

```
GET https://www.minimaxi.com/backend/account/token_plan_credit?business=Agent&device_platform=desktop
```

whose answer carries `total_credits`, `used_credits`, `remaining_credits`,
`credit_packages_details[]` and the `balance_breakdown` buckets.

## The usage profile

```
GET https://www.minimaxi.com/backend/account/token_plan/usage_summary?token_type=5&heatmap_days=365&business=Agent&device_platform=desktop
```

The answer carries `total_days`, `total_token_consumed`, `usage_ranking_percent`,
`most_active_day`, `active_days`, `current_consecutive_days`, and per-day
`date_model_usage[]` with a per-model breakdown (including
`cache_hit_percent`).

## What the catalog does not carry

**No promotion-shaped fields.** A search of the whole catalog answer for
`modelPromotions`, `promotions`, `activities`, `discount` and `free_trial`
found nothing. The plugin therefore draws no activity badge: a badge would
have to be invented, and an invented badge is worse than no badge.

**No price fields.** The model catalog carries the models and their limits,
but nothing about what a request costs, so the plugin cannot say what a
title request or a long turn spent.

## The model catalog

```
GET https://agent.minimax.cn/mavis/api/v1/models
Authorization: Bearer <the desktop app's OAuth token>
```

The answer carries `providers[].config.models`, each with `name`,
`attachment`, `reasoning`, `limit.context`, `limit.output` and `modalities`.

At the time of measurement the catalog carried **two** models,
`MiniMax-M3` and `MiniMax-M3.1-Flash`, both with a 512,000-token context and
a 128,000-token output limit. There was **no lighter model** in it — which
is why the plugin does not divert the host's session-title requests
elsewhere; see the changelog for that entry.
