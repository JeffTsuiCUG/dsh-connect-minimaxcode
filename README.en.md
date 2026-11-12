# DSH Connect MiniMax Code (`dsh-connect-minimaxcode`)

Bring the models of the **MiniMax Code desktop app (China region)**, already signed in on this machine, into **DeepSeek Harness (DSH)**. Install it and it works — there is no API key to configure.

![license](https://img.shields.io/badge/license-MIT-blue.svg)
[![version](https://img.shields.io/npm/v/dsh-connect-minimaxcode?color=cb3837)](https://www.npmjs.com/package/dsh-connect-minimaxcode)
[![CI](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/actions/workflows/ci.yml/badge.svg)](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/actions/workflows/ci.yml)

[简体中文](README.md) | English

## Inspiration

The community established the route this plugin follows: **a model already signed in on a desktop app can be moved into DSH with zero configuration** — no handling of accounts or passwords, no new authentication scheme; it just attaches a provider to the login state the machine already has and reuses DSH's built-in provider adapter. This plugin applies the same approach to MiniMax Code:

| | Sibling plugins | This plugin |
|---|---|---|
| Data source | Local login state of their own desktop app | Local login state of the MiniMax Code desktop app |
| Integration | Registers a DSH provider and exposes the already-signed-in models | Same |
| Catalog source | Live model list from upstream | Same |

Several implementations exist in the same direction; for **how the plugin is structured and how the provider is registered**, this plugin follows **[dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)** and the same author's [dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae).

> These projects are developed independently and are not affiliated with this one. This plugin's directory layout and `cordis.patch.yml` follow the existing conventions of the DSH plugin structure.

---

## ⚠️ Important notice (read this first)

- **This project is for learning and research only.** It is not aimed at production use and comes with no commercial support.
- **This is an unofficial plugin.** It is not affiliated with MiniMax or DeepSeek, and is not endorsed or authorized by either of them.
- The plugin only **reads the credentials of the MiniMax Code account already signed in on your own machine**, and only drives **your own account on your own computer**.
- **Do not** use this plugin for commercial purposes, beyond reasonable personal use, or for any bulk / multi-account / limit-evasion purpose.
- The plugin depends on **undocumented (non-public) MiniMax client APIs**. When MiniMax updates its client, those APIs may change and the plugin may stop working.
- You are responsible for complying with the [MiniMax Terms of Service](https://agent.minimax.cn/doc/zh/terms-of-service.html). You bear all consequences of using this plugin (account restrictions, quota resets, service interruption, and so on).
- The authors of this project are not liable for any direct or indirect loss caused by the use or misuse of this plugin.

---

## Highlights

- **Zero configuration**: the login state of the MiniMax Code desktop app is read automatically, and no plaintext token is ever stored in DSH
- **Dynamic model catalog**: pulled live from the upstream API, so upstream adding or removing models needs no plugin update
- **Credit balance at a glance**: the pill in the composer tool row (beside the model picker) shows the remaining MiniMax Code credits and the consumption accumulated on this machine
- **Live usage accounting**: the token usage of every request is taken from the upstream response itself, and can be converted to an equivalent cost using the official price list
- **Reuses the official adapter**: upstream speaks the standard Anthropic Messages protocol, so DSH's built-in provider is reused as is; tool calls, reasoning blocks and context compaction are all handled by DSH
- **Works without the desktop app**: the plugin can sign in on its own with the OAuth device code flow; you confirm in your own browser and the plugin never sees a password
- **Daily check-in**: MiniMax Code grants credits every day and the desktop app does **not** claim them for you; the plugin shows the seven-day cycle and can claim the day's grant
- **Read-mostly**: apart from "refreshing an expired desktop app login state" and the sign-in you start yourself, the plugin does not write to or modify any MiniMax file
- **Follows the selected model**: the balance sits in the **composer tool row beside the model picker**, and is drawn **only while a MiniMax model is selected** — picking another connector's model hides it entirely instead of misleading you with MiniMax's balance
- **An icon and two languages of its own**: a 48×48 SVG ships with the package, so the plugin page no longer shows the default placeholder; the title and the introduction come in Chinese and English, and the interface follows the host's language
- **Image input**: models whose catalog entry declares the `image` input modality (`M3`, `M3.1-Flash`) take pictures directly; the host's attachment service reads the image into request bytes, and the plugin only has to connect the durable reference to it

## Prerequisites

Either:

1. **The MiniMax Code desktop app (China region) installed and signed in** — the plugin reuses its sign-in (the easy way)
2. **Nothing installed** — press "Sign in to MiniMax Code" on the plugin page; the plugin starts an OAuth device code flow and you confirm with your own MiniMax account in a browser (this needs `account.minimax.cn` to be reachable)

Plus DSH desktop (built-in core `>=0.2.1-rc.2 <0.3.0`, see `engines.dsh` in `package.json`; tested on `0.2.1-rc.2`) or the Web profile.

> **Sending a picture needs the host's attachment service**: the plugin does not read images itself — the host's durable attachment service turns a stored reference into request bytes, and the plugin only connects the two. On a host without that service the plugin still loads and text still works; only image requests are refused (`pi-ai image input requires the durable attachment service`).

## Installation

**Option 1: install from the Git repository** (recommended, gets the latest code)

```bash
dsh plugin --profile desktop add github:JeffTsuiCUG/dsh-connect-minimaxcode
```

**Option 2: install from npm** (available once published)

```bash
dsh plugin --profile desktop add dsh-connect-minimaxcode
```

For the Web profile, replace `--profile desktop` with `--profile web`.

> **Installing a locally modified clone**: do not pass a directory path to `dsh plugin add` — pnpm installs it as a link and nests dependency symlinks inside the plugin's own `node_modules`; the host's plugin sandbox gets `EPERM` stat-ing those links and the plugin fails to activate (`failed to import`). Pack a tarball first, then install the tarball so dependencies resolve in the profile root `node_modules` like a registry install:

```bash
pnpm pack
dsh plugin --profile desktop add ./dsh-connect-minimaxcode-0.5.6.tgz
```
> The desktop profile is owned exclusively by the Electron app. If the `dsh` command is not on your PATH, use the carrier CLI bundled with the DSH app (the path depends on the install location, for example `<DSH install dir>\resources\runtime\cli\bin\dsh.cmd`).

After installing, the plugin hot-reloads, and the models then show up under the **MiniMax Code** group in the model picker.

> The credit pill and the plugin page card are browser-side plugins, so **the first install, or an upgrade to 0.3.0 or later, requires one DSH restart** before they appear (the model route itself does not need a restart).

### If the install is blocked by `allowBuilds`

This repository commits the build output `lib/`, so a normal install does not trigger a build. If you see:

```text
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package
```

it means you are on **a commit older than `0.2.1`** (those versions did not commit `lib/` yet). Two ways out:

- Pin a version with the syntax above: `github:JeffTsuiCUG/dsh-connect-minimaxcode#v0.2.1`
- Or add the `allowBuilds` entry pnpm suggests to that profile's `pnpm-workspace.yaml` and retry

## Usage

1. **Confirm the desktop app is signed in**
   Open the MiniMax Code desktop app and check that you are signed in. The plugin reads the local login state that the app writes.

2. **Install the plugin** (with the command above) and wait for the hot reload to finish.

3. **Pick a model**
   Open the DSH model picker and choose a model under the **MiniMax Code** group. The available models come from the live upstream catalog, for example `M3`, `M3.1-Flash`.

4. **Chat as usual**
   Just use it. Tool calls are executed by DSH's local tools; the plugin only provides the model channel.

5. **Sign in again when the token expires**
   MiniMax Code has **two login states that are not interchangeable**, and this plugin uses one of each:

   | Credential | Location | Lifetime | Used for |
   |---|---|---|---|
   | JWT | `~/.minimax/local-runtime.auth.json` | about 15 days | Model gateway (`/mavis/api/v1/llm/v1/messages`) |
   | OAuth (`mmoat_`) | `~/.minimax/auth/prod/<region>/mcode-public/auth.json` | about 1 hour | Account and credit reads (`/matrix/api/v1/commerce/get_membership_info`) |

   The two credentials are not interchangeable: the JWT gets `401` on every account API call, and the OAuth token does not work against the model gateway. **Model traffic** uses the JWT, **the credit display** uses OAuth.

   | Symptom | Meaning | What to do |
   |---|---|---|
   | Everything works | Both credentials are valid | — |
   | The model reports an auth error | The JWT has expired | **Sign in again** in MiniMax Code, then restart DSH |
   | The credit pill says "login state expired" | The OAuth token expired | The plugin refreshes it with the app's own refresh token and writes it back; if the refresh fails, open the MiniMax Code desktop app once and let it refresh itself |

   > An expired OAuth token does **not** affect model traffic: the JWT is still valid and the model works as usual — only the credit pill cannot fetch a balance for a while.
   >
   > The refresh **rotates** the refresh token. The plugin therefore writes the new token pair back to the same file atomically, in the client's **original format**, and leaves `generation` unchanged — the client relies on it to decide "does this credential still belong to the current login", and raising it on its own would make the desktop app think the login came from another machine.

### About response latency

These MiniMax models **require reasoning before any output and cannot turn it off**. Therefore:

- There is a wait before the first character appears (measured: about 3 seconds for M3.1-Flash)
- The reasoning is streamed back live as `thinking` blocks, so you can see the model "thinking" in the interface
- This is the model's own behaviour, **not latency caused by the plugin**

If you care more about the immediacy of streaming feedback, keep one of DSH's official models or another provider as a fallback.

## How it works

1. Read `~/.minimax/local-runtime.auth.json` (the plaintext login information the MiniMax Code app writes) and **parse its JWT in memory only**
2. Call `GET /mavis/api/v1/models` to fetch the live model catalog (including context length, multimodal support, tool calling and other capability declarations)
3. Register the `minimaxcode` provider, pointing at `POST /mavis/api/v1/llm/v1/messages` (the standard Anthropic Messages protocol)
4. Read the OAuth token from `~/.minimax/auth/prod/<region>/mcode-public/auth.json` and refresh it when needed
5. Call `POST /matrix/api/v1/commerce/get_membership_info` for the credit balance, and hand it to the UI pill through the plugin's own status endpoint `/plugins/dsh-connect-minimaxcode/status`

### Three compatibility fixes for the gateway

These are the differences that had to be handled in practice, and they are the main reason this plugin is not "just a different URL and it works":

| # | Symptom | Fix |
|---|---|---|
| 1 | The gateway only accepts `Authorization: Bearer`, while pi-ai sends `x-api-key` by default; the latter on its own returns `401 token is required` | Attach an `Authorization` header to the model descriptor (the gateway accepts both headers) |
| 2 | The Anthropic SDK appends `/v1/messages` to `baseUrl` itself; if `baseUrl` already ends with `/v1`, the request path becomes `/v1/v1/messages` and the gateway returns `503 direct_route_not_configured` | Cut `baseUrl` before the version segment and let the SDK complete it |
| 3 | Every model requires reasoning, and "disable reasoning" makes pi-ai send `thinking: {type: "disabled"}`, which the gateway rejects with `400 ... requires adaptive thinking` | Mark the "off" level as unsupported so the field is omitted (which the gateway accepts) |

The plugin contains **no** hardcoded token, account or API key.

## Signing in without the desktop app

The plugin can sign in on its own, using the same **OAuth 2.0 device authorization grant** (RFC 8628) the desktop app uses:

1. The plugin asks `account.minimax.cn/oauth2/device/code` for a device code and gets an eight-character user code and the page to authorize it.
2. You open that page, sign in to **your own** MiniMax account, and approve the request.
3. The plugin polls `oauth2/token` and receives the `mmoat_` token and a refresh token.

What this means in practice:

- **The plugin never sees a password or a verification code** — the only human step happens in your own browser, on the account site's own page.
- **PKCE is used**, so a leaked device code cannot be redeemed without the verifier that never leaves the process.
- **One token is enough**: the `mmoat_` token works against the model gateway (`agent.minimax.cn/mavis/api/v1/llm`) *and* the account endpoints (credits, check-in), so one sign-in covers all of it.
- **The desktop app's files are left alone.** The plugin keeps its own credential in `~/.dsh/.minimaxcode-auth.json` (mode 0600, atomic write). The app's two files carry `generation` counters that must stay in step, and writing there would look like a sign-in somewhere else and force a new one.
- **The refresh token rotates**, so the plugin writes the new pair back to its own file and the sign-in keeps working.

## The daily check-in

The free credits are granted by a **daily check-in**, not by signing in. The desktop app has a "每日签到" card, but it does **not** claim on its own — the card opens and you press the button.

The upstream endpoints are:

```
GET  /minimax-cloud/api/v1/signin/status?timezone_id=Asia/Shanghai   # the seven-day cycle
POST /minimax-cloud/api/v1/signin/claim?timezone_id=Asia/Shanghai   # claim today's grant
```

Measured behaviour:

- **The time zone must be an IANA name** (`Asia/Shanghai`). An offset, or none at all, is answered with `invalid timezone_id`.
- **A cycle runs seven days**: 400 / 400 / 400 / 1000 / 400 / 400 / 1000 = **4000 credits**.
- **Claimed credits are valid for thirty days** (the response's `expire_at_ms` is exactly thirty days later, at midnight in the account's time zone).
- **The claim is idempotent per day**: claiming again answers `claim_result: 2` (already claimed) and grants nothing.

The plugin page shows which day of the cycle it is, what that day is worth, and which days are left, and offers two actions:

- **A "Claim" button** — you press it and the plugin claims the day's grant.
- **A "Claim daily on its own" switch** (off by default) — with it on, the plugin claims once a day, and only when the server itself says the day can be claimed.

The automatic claim is deliberately restrained: it only asks when the upstream says the day is claimable, at most once a day, never concurrently, never around any verification, and it shows the reason when something goes wrong rather than retrying quietly. Please check that this is within MiniMax's terms of service yourself.

## Credit balance and usage

The pill in the composer tool row (beside the model picker) shows the **remaining MiniMax Code credits**; expanding it also shows the granted/purchased split, the consumption between the two reads, and the tokens and equivalent cost accumulated on this machine. The pill appears **only while a `minimaxcode` model is selected**.

### Where the balance comes from

The MiniMax Code desktop app calls a "membership info" API every day itself, and the response carries the three numbers shown on the app's settings page:

```
POST https://agent.minimax.cn/matrix/api/v1/commerce/get_membership_info
Authorization: Bearer <the desktop app's mmoat_ OAuth token>
Content-Type: application/json

{}
```

```json
"op_credit_summary": {
  "total_remaining_amount": "11459.454",      // total remaining credits
  "purchased_remaining_amount": "0",           // of which purchased
  "free_remaining_amount": "11459.454"         // of which granted
}
```

What the plugin reads is `op_credit_summary.total_remaining_amount`. **Mind the field**: `total_remains_credit` and `opcredit_balance` in the same response are legacy balances; on accounts that have already migrated to the credit pool they are always `0`, so reading them shows "0 credits".

Incidentally, there are three **different units of "money"** here — do not mix them up:

| Value | Meaning | Shown by this plugin |
|---|---|---|
| `op_credit_summary.total_remaining_amount` | Code credit balance | ✅ This is the one |
| `token_plan_credit.remaining_credits` | Purchased credit pool | ❌ |
| `query_balance.available_amount` | Open Platform wallet (CNY) | ❌ |

### Do credits expire? Yes

Credits are not a single pool but **lots granted one at a time**, each with its own expiry date. The client grants one lot per day, and each lot expires on **the grant date + 30 calendar days** (it lapses at 00:00 on that day, in the account's time zone), which forms a 30-day ladder staggered by one day:

```
GET https://agent.minimax.cn/minimax-cloud/api/v1/credit/details?page_number=1&page_size=100
→ details[] { granted_amount, remaining_amount, consumed_amount, granted_at_ms, expire_at_ms, credit_type }
```

Measured on this machine, 23 lots: the one granted on 09-20 expires on 10-20, the one granted on 09-21 expires on 10-21, and so on; one granted on 08-25 expires on 2027-08-25 (a one-year lot; `credit_type` 1 = purchased / 2 = check-in). **Always read the expiry date from `expire_at_ms`** instead of hardcoding a number of days — there are at least a 30-day and a 365-day scheme.

Based on that, the plugin shows, in the **plugin page** (Settings → Plugins → DSH Connect MiniMax Code) and in the pill in the composer tool row:

- The remaining credits **expiring within 7 days**, and the expiry date of the most recent lot
- The remaining credits **expiring within 30 days**
- A list of the **upcoming expiring lots** (date + amount)
- The balance bar and the consumption on this machine (token count, equivalent cost)

Only lots that **still have a balance** are counted: a lot that was granted but already spent has nothing left to lose when it expires, and counting it would make every account look "about to expire". Consumption is roughly first-in, first-out, so **the "expiring within 7 days" amount is often 0** (the lots that are about to expire are basically used up already), which is why the interface also shows the **earliest expiry time** — that is the signal that actually means something.

> Expiry does not zero out a lot's `remaining_amount` (in practice a negative residue such as -0.31 is left behind); it excludes the expired lots **from the balance** instead, so the total comes from the balance API.
>
> The sum of `remaining_amount` in the ledger is digit-for-digit equal to `total_remaining_amount` from the balance API **while nothing is being spent**; the difference seen between two samples is what the account really spent during that window.

### How usage is computed

Two sets of data each cover one thing:

- **Real credit consumption**: the balance is a live value, so the difference between two reads is the credits actually spent in that window (the client spends concurrently as well, so the difference includes spend from the other clients).
- **Consumption on this machine**: every response carries its own `usage` (`input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`), which the plugin accumulates as is. When converting to money, **compute from these four components alone** — never use any `total_token` aggregate, because upstream's two aggregation levels use different bases (they differ by 1.94×, and the difference is exactly the cache-read part). The prices come from the [official MiniMax price list](https://platform.minimax.cn/docs/pricing/overview):

  | Model | Input | Output | Cache read |
  |---|---|---|---|
  | `MiniMax-M3.1-Flash` | ¥1.00 / 1M tokens | 4.00 | 0.10 |
  | `MiniMax-M3` (≤512k input) | 2.10 | 8.40 | 0.42 |
  | `MiniMax-M3` (>512k input) | 4.20 | 16.80 | 0.84 |

  The converted amount is an **equivalent cost, not a charge**: MiniMax publishes no exchange rate between credits and money (the plans only publish relative multipliers of 1×/3×/12×), so the plugin does not present it as "how many credits were spent".

  > The official price list has no separate price for **cache writes** (`cache_creation_input_tokens`), so the plugin counts its tokens but **does not convert them to money**, to avoid quoting a number that has no public basis.

### Account usage profile

The account's **usage history** comes from the open platform's usage summary, and it is a different thing from the token count the pill reports: the latter counts only the requests this host made.

```
GET https://www.minimaxi.com/backend/account/token_plan/usage_summary?token_type=5&heatmap_days=365&business=Agent&device_platform=desktop
Authorization: Bearer <OAuth 令牌>
```

The card shows the parts worth acting on:

| Field | Meaning |
| --- | --- |
| `current_consecutive_days` | Days used in a row |
| `active_days` / `total_days` | Days with usage in the window / the window's length |
| `total_token_consumed` | Tokens consumed in the window, in the upstream's own wording (`826.14M`) |
| `usage_ranking_percent` | Where the account ranks by usage |
| `most_active_day` | The busiest day and what it consumed |

This data **needs no M Plan subscription**: the endpoint is an account one, read with the OAuth bearer, unlike the limit windows, which belong to the subscription.

### Image and video generation (H3)

The plugin page gained a **Generate** panel, which drives MiniMax's **H3 image
model** and **H3 video generation** directly:

- Images: `MiniMax-H3-Image` (and `MiniMax-H3-Image-Highspeed`), with an
  aspect ratio and a 1K / 2K / 4K area
- Video: `MiniMax-H3`, with a length of 5–15 seconds, 768P / 2K and an
  aspect ratio

Both go through the endpoints the open platform's own documentation gives:

```
POST https://api.minimax.cn/v1/images/generations          # text to image, synchronous
POST https://api.minimax.cn/v2/video_generation           # create a video task, asynchronous
GET  https://api.minimax.cn/v2/query/video_generation/{id}  # poll the task
```

**No key has to be configured.** The generation endpoints want the open
platform's API key (`sk-cp-…`), and that key belongs to the *account*: the
plugin asks `token_plan_credit` with the OAuth bearer — the endpoint it
already reads for the credit balance — and the `api_key` in the answer is
it. Measured on 2026-11-10:

| Request | Credential | Result |
|---|---|---|
| `/v1/images/generations` + `sk-cp-` key | 200, 8.5 s | 1184×880 JPEG, 395 KB, 6401 tokens |
| `/v1/images/generations` + OAuth bearer | 401 `1004 login fail` | the endpoint takes only the API key |
| `/v2/video_generation` + `sk-cp-` key | 200, task `succeeded` after 90 s | 5 s 768P clip, 162745 tokens |

The generated picture is **committed to DSH's own attachment store**
(`ctx.attachments`), so it lives in DSH's storage rather than only in this
browser tab.

#### Two differences from the desktop app, stated plainly

1. **It cannot appear in the model picker like an ordinary model.** The host's
   `ctx.llm` has exactly one registration point, `registerAdapter`, for
   chat adapters; there is nowhere to register an image provider. The model
   descriptor `LlmModelInfo` has no output-modality field, so the picker
   could not tell an image model apart. pi-ai does have an image-generation
   API (`ImagesProvider` / `generateImages`), but DSH never constructs an
   `ImagesModels`, and one the plugin built for itself would have nothing
   reading it. All three are host-side, and a plugin cannot change them.
2. **Video has no carrier in DSH at all.** Across `pi-ai`, `dsh-llm`,
   `dsh-attachment` and `dsh-llm-pi-ai` there is not one video-related
   declaration: no video content block, no attachment media type, no
   rendering. A video can therefore be generated, watched and downloaded in
   the panel, but it cannot join a conversation the way a picture can.

A picture *can* reach a conversation: the host publishes
`ctx.attachments.admitPromptContent()`, so a plugin can complete "generate →
store → durable reference" on its own. But the attachment entry point is a
browser `File` upload and there is **no attachment library** to pick from,
so it still has to travel as part of the next prompt. That last hop is
done in 0.6.1 (see below).

### About token refresh

The OAuth token is valid for about an hour and is refreshed automatically by the client. The plugin **only refreshes it once, with the refresh token the app already stored, when its own token has expired**, and writes the rotated new tokens back to the same file atomically, in the client's **original format** (with `generation` unchanged), so the desktop app's login state is unaffected. The plugin never starts a login, never signs out, and never calls any paid or subscription endpoint.

> The conclusion of this section is the opposite of what 0.2.x reported ("the quota cannot be displayed"). The investigation at the time guessed endpoint paths from English semantics like `credits` / `quota` / `summary`, but the real API uses the `commerce` / `membership` vocabulary of the billing domain, so every guess missed; the path was later pinned down by reading the URL the desktop app really calls every day out of its own runtime logs (`%APPDATA%\MiniMax\logs\api-*.log`).

## Known limitations

- **Only the China region (`agent.minimax.cn`) is supported**. Whether the international gateway works is **unverified** — please do not infer that other regions are supported from this.
- **Reasoning must stay enabled**. All MiniMax models declare that they need reasoning and it cannot be turned off. The time to first token is therefore higher than for non-reasoning models.
- **The model list is a built-in fallback when you are not signed in**. The picker still shows the two built-in entries `M3` and `M3.1-Flash` in that state, but they cannot really be called; once you sign in, the list switches to the live upstream catalog. Judge availability by the result of an actual call.
- **Credits only cover the granted/purchased MiniMax Code credits**; they do not include the Open Platform wallet balance or the purchased credit pool, and the plugin never converts money into credits.
- **The balance is an account-level number**, so the difference between two reads includes concurrent spend from the other MiniMax Code clients; the consumption of this machine alone is the token count and the equivalent cost in the pill.
- **The equivalent cost is an estimate converted at the public price list**, not an actual charge; MiniMax publishes no exchange rate between tokens and credits.
- **When the OAuth token expires the credit pill is temporarily unavailable**. With the desktop app's sign-in, open MiniMax Code once and let it refresh itself; with the plugin's own sign-in, the plugin renews it with its refresh token (the server rotates the refresh token, and the plugin writes the new pair back to its own file). This does not affect model traffic.
- **The check-in needs an account that is entitled to it.** The check-in is an upstream entitlement; the plugin only presses the button for you. When the server says "not claimable now", the plugin says so — it does not retry or work around it.
- **The automatic claim is off by default**, and it only asks when the server explicitly says the day can be claimed, at most once a day. Whether to turn it on, and whether that is within MiniMax's terms of service, is your call.
- **No settings card is provided**. The plugin does not register a card on the DSH settings page; the interface it adds is a single pill in the composer tool row (**drawn only while this plugin's model is selected**) and a small card on the plugin page.
- **The upstream APIs are non-public** and may stop working when MiniMax updates its client. If the balance API breaks, the pill shows "credits unavailable", which does not affect model traffic.
- **Image input depends on the host's attachment service.** The catalog declares the `image` modality (`M3`, `M3.1-Flash`), but turning a durable attachment into request bytes is the host's job: without that service the plugin still loads and serves text, and only image requests are refused.
- **The context window is declared as the gateway's real ceiling (1,000,000), not the 512,000 in the catalog.** Upstream's `limit.context` is the *default* window and the billing tier boundary (input above 512k costs more); the largest entry of `context_window_options` is the ceiling the gateway enforces. Measured on 2026-10-25: 946,206 tokens were served normally, 1,050,000 were refused (`invalid params, context window exceeds limit (2013)`). Declaring 512,000 meant every turn of a long conversation was reported as `pi-ai detected context overflow` — while the model had answered perfectly well and the reply was thrown away.
- **The device code flow needs `account.minimax.cn` to be reachable**, and the browser that authorizes it has to be able to sign in to a MiniMax account. On some restricted networks the authorization page cannot be opened.

## Changelog

### 0.6.5 (2026-11-12)

- **Fixed "the limit windows never showed up"**: once a plan is held, the upstream changed the quota endpoint's **field names and its meaning** — from the share *used* (the string `"19%"`) to the share *remaining* (the number `90`). The plugin still read the old names, so the windows either could not be read at all or read as the opposite. Both shapes are accepted now, and what leaves the plugin is always the share *used*: 92% remaining is 8% used. The window length is still derived from the answer's own edges (measured: five hours and seven days) rather than assumed.
- **Added the plan to the card**: the membership answer now names the tier and the day it ends (`token_plan_tier`, `token_plan_expires_at`), and the plugin shows one more line in the pill detail and on the plugin page — "Go · until 2026-12-11". It comes from the same answer as the balance, so it costs no extra request.
- **An account without a plan sees exactly what it saw before**: the plan fields are simply absent there, so the plugin shows nothing about a plan; the windows are still absent, and the card still says "No M Plan subscription (credits only), so there are no usage windows". The new `tests/free-account.spec.ts` pins that whole path for a free account (balance, plan, windows), and `tests/plan.spec.ts` covers the new field shape, the old one and the free account.

### 0.6.4 (2026-11-11)

- **Fixed "the self-check report never appeared"**: the previous version put the self-check in the client half (the card reports what the host offered), but **the server half was never landed** — the status document had no field to carry the report and no route to receive it, so the card reported into nowhere. It is complete now: the report is received by the plugin's own route and appears in the status document as `capability`.
- The episode also exposed a process problem: a few anchors in the patch script missed, and its output was covered by another script in the same command, so a partial application was read as a complete one. **Every patch is now checked individually**, and an end-to-end check was added: the report counts as working only once it has travelled from the card through the route and back into the status document.
- The route-count cases were brought up to date (the host now mounts four routes: status, action, capability, generation).

### 0.6.3 (2026-11-11)

- **"Could not send it to the conversation" now names the missing piece**: delivering a picture needs several pieces of the host — the session identifier, the sessions service, the session binding, a way to send or to hold a draft, and the input box's attachment channel — and they arrive in different ways. There used to be one blanket failure message; each absence now has its own: the host named no session / offers no sessions service / this session is not reachable / it cannot send / it cannot hold drafts / the input box takes no attachments.
- **The plugin checks itself and reports**: the card tells the plugin's own route what the host actually offered when it mounts, so the status document carries that report — working on a failure no longer depends only on the sentence on the screen.
- Also fixed a real defect the tests caught at once: the report referred to the session identifier before it was defined, and the host fires effects early, so the script broke.
- `tests/generate-dock.spec.ts` grows to 8 cases, covering the report's content and the wording when no session is named.

### 0.6.2 (2026-11-11)

- **Fixed "could not send it to the conversation"**: the previous version looked for the session among the slot's props, but the host hands the session to the slot's **injection callback** (the slot is session-scoped), so the identifier was always missing and the picture had nowhere to go. The session is now taken the way the host gives it.
- **One more way to deliver**: when the host offers no session face to send with, the plugin falls back to the input box's own attachment channel — the very road a picture dragged in by hand takes, so it appears in the input box and you press send.
- The picture's arrival is the feedback, so nothing is left on screen and the composer stays clean.
- `tests/generate-dock.spec.ts` rewritten to drive the plugin **the way the host does** (6 cases): the session identifier arrives through the injection, the picture travels as `{type:"image", mediaType, data}` with the prompt, the fallback into the input box when there is no way to send, and the message shown when neither is there.

### 0.6.1 (2026-11-11)

- **A generated picture can now go straight into the conversation**: the composer tool row gained a **Generate an image** entry. Write a prompt, press generate, and the picture is sent as part of this turn — through the host's own road (`ctx.sessions.binding(id).session.prompt(content, mode, signal, requestId)`, the very call the send button makes), so the host validates it, commits it as a durable attachment and treats it as an ordinary message.
- A host that exposes no session face gets a plain "could not send it to the conversation" instead of a silent failure, and the plugin page's panel keeps working regardless.
- Added `tests/generate-dock.spec.ts` (4 cases) pinning: the entry is registered in the tool row, it declares the `sessions` service, the picture travels as `{type:"image", mediaType, data}` (raw base64, no data-url prefix) together with the prompt, and the message shown when there is no session to send to. All 252 cases pass.

### 0.6.0 (2026-11-11)

- **Added H3 image and video generation**: the plugin page gained a **Generate** panel that drives MiniMax's `MiniMax-H3-Image` (text to image) and `MiniMax-H3` (video) directly. It goes through the endpoints the open platform's documentation gives (`POST /v1/images/generations`, `POST /v2/video_generation` plus polling `/v2/query/video_generation/{id}`), and **no key has to be configured**: the generation endpoints want the account's own open-platform key, and the plugin gets it by asking `token_plan_credit` with the OAuth bearer — the endpoint it already reads for the balance.
- **Generated pictures are committed to DSH's own attachment store** (`ctx.attachments`), so they live in DSH's storage rather than only in a browser tab.
- The choices (aspect ratio, area, length, resolution) are published by the server, and they are the ones the upstream really serves.
- **Measured** (2026-11-10): a picture in 8.5 s, 1184×880 JPEG / 395 KB / 6401 tokens; a 5 s 768P video whose task reached `succeeded` after 90 s, 162745 tokens. The generation endpoints take only the API key and refuse the OAuth bearer (`1004 login fail`) — every step of that chain is pinned by tests (new `tests/generation.spec.ts`, 12 cases).
- **The differences from the desktop app, stated plainly**: H3 **cannot appear in the model picker like an ordinary model** (the host's `ctx.llm` has a single chat-adapter registration point, and the model descriptor has no output-modality field), and **video has no carrier in DSH at all** (not one video-related declaration across the four packages). A picture can reach a conversation, but the attachment entry point is a browser upload with no library to pick from, so it still has to travel as part of the next prompt — that last hop is planned for the next release.

### 0.5.10 (2026-11-10)

- **Removed the `awesome-dsh-plugin-submission/` directory**: the listings are no longer maintained, the draft entry in it was merged into the official registry long ago, and the rules it described are spelled out in the upstream `contributing.md`. Keeping it only suggests it is still needed. The README's mention of it is gone as well — where the changelog mentions the directory, the text stays but the link does not, so no dead link is left behind.

### 0.5.9 (2026-11-10)

- **README**: every reference to a repository that no longer exists (it now answers 404) is gone — the inspiration section, the sibling-plugin table and its section, and the acknowledgements. The practice it established and the sibling projects that followed it are still described, and every repository link left in the README was checked to be alive.
- **README**: the marketplace section now states the situation as it stands — all twelve listing pull requests are closed, the forks opened for them are cleaned up, those directories are not being worked on, and distribution runs through npm and this repository's releases. The two registries that still carry an entry (the official registry and dshbase) are still listed. The npm package ships the README, so this change needs a release to reach the package page.

### 0.5.8 (2026-11-10)

- **Fixed "M3's reasoning could not be turned off"**: the plugin used to declare "reasoning cannot be disabled" for *every* reasoning model, on the grounds that the gateway refuses `thinking: {type: "disabled"}` with `400 ... requires adaptive thinking`. That refusal only holds for a `forced_on` model: the upstream catalog states `thinking_config.mode` per model, and `MiniMax-M3` is `switchable` (measured: the disabled form is accepted, 200) while `MiniMax-M3.1-Flash` is `forced_on` (measured: 400). Each model is now handled as upstream describes it: **M3's reasoning levels now include "off"**, and picking it really does stop the reasoning — fewer tokens, lower latency. M3.1-Flash is unchanged and the option still does not appear.
  Upstream's `effort_options` (six levels for M3.1-Flash: default/low/medium/high/xhigh/max) are parsed and recorded but **not wired**: pi-ai's level mapping still dispatches the budget form, and reaching those six levels would switch the whole request shape, which this change does not do.
- **New "account usage profile"**: reads the open platform's `GET /backend/account/token_plan/usage_summary` (a constant this plugin had defined and never used). The card shows the consecutive days of use, the active days in the window, the tokens consumed in it, the usage ranking and the busiest day. It describes the *account*'s history, which is a different thing from the token count the pill reports for this host.
- **Says why there are no limit windows**: an account without an M Plan subscription gets `2062 no active token plan subscription` from upstream (already recognised in 0.5.7). The card now states that outright instead of leaving the reader to assume a failed read.
- **Endpoint survey**: every one of the twenty account-domain endpoints the desktop app calls each day was mapped — **nineteen of them are readable with the OAuth bearer and need no subscription at all**. What a subscription buys is not more endpoints but two things: the limit windows and a larger allowance.
- Added `tests/usage-profile.spec.ts` (16 cases) plus reasoning-mode cases in `tests/catalog.spec.ts` / `tests/adapter.spec.ts`. All 236 cases pass.

### 0.5.7 (2026-11-10)

- **The quota readout now uses the open platform's documented endpoint**: the plugin read `/backend/account/token_plan/remains_percent`, and that path now answers every account with an empty `success` — it no longer even carries a `model_remains` field — so the readout showed nothing for anyone and said nothing about why. It now reads `GET /v1/token_plan/remains`, the endpoint the open platform's own M Plan documentation names. That endpoint asks for the **open platform's API key** rather than the OAuth bearer; the key comes from the `token_plan_credit` response and is remembered between reads.
- **"No subscription" is no longer reported as a failed read**: upstream answers an account without an M Plan subscription with `2062 no active token plan subscription` — credit packages carry no rolling windows of their own. The plugin now reports that as what it is. The balance, the check-in and the model calls are untouched by it.
- The older path is kept as a **fallback**: an account whose open platform hands out no key still gets whatever the old path can give.
- Fixed a misfire that came with it: the quota endpoint is asked with the open platform's plan key, so a 401 there means the *key* is wrong, not that the person's credential was revoked. It used to feed the "was this credential revoked" check, which could sign someone out over a bad key. That check now reads only the account-domain endpoints (membership and credit ledger).
- Added `tests/quota-endpoint.spec.ts` (13 cases) pinning: how the plan key is obtained, the documented endpoint being asked with the key rather than the OAuth bearer, `2062` counted as "no subscription" rather than an error, the fallback to the older path when there is no key, and the key being fetched once. All 209 cases pass.

### 0.5.6 (2026-11-09)

- **Fixed "every model request fails while credits and check-in still work"**: the two features read two different credential files. The model gateway only knew the plugin's own sign-in and the **legacy JWT** an older desktop app left behind (`local-runtime.auth.json`), while current installs store an OAuth grant instead (`auth/prod/<region>/mcode-public/auth.json`, an `mmoat_` token). Once the legacy JWT expired, the gateway answered every request with `401 auth failed` — and because credits read the OAuth file, the card showed a healthy balance beside a dead model. The gateway now tries, in order: the plugin's own sign-in → **the desktop app's OAuth grant** → the legacy JWT, taking the first that works.
- **Fixed a revoked token never prompting a new sign-in**: revocation does not change the locally recorded expiry, and the refresh check **looked only at that expiry**, so a dead token was used forever, every request answered `401`, and the card kept claiming a sign-in with no way back. An account endpoint answering `401` now forces one refresh; when the refresh itself is refused (`400`/`401`/`invalid_grant`, or a credential that carries no refresh token) the credential is deleted, the cached views of the account are dropped, and the card asks for a new sign-in. **A network error or a `5xx` is not a revocation** — a bad minute upstream must not sign anyone out.
- **Fixed the status card reporting a working machine as expired**: the card's sign-in state read only the legacy JWT, so it said `expired` even when the gateway worked. It now describes **the credential the gateway will actually use**, and adds `credential-revoked` / `credential-expired` hints that point at the card's own sign-in button instead of "sign in to the desktop app and restart DSH".
- Added `tests/revoked-credential.spec.ts` (6 cases) pinning: the credential is dropped and the card goes signed-out after a `401`, a refusal yields a "sign in again" remedy, a `503` leaves the credential alone, a plugin-only sign-in reports as signed-in, the OAuth grant wins over the legacy JWT, and the status document never leaks a token. All 193 cases pass.

### 0.5.5 (2026-11-06)

- **New "rate-limit windows" readout**: reads the open platform's `GET /backend/account/token_plan/remains_percent` (found in the desktop app's own traffic, likewise undocumented) and shows the plan's **5-hour window** and **weekly window** with used percentages and a reset countdown. Window lengths are derived from the response's own edges, never hard-coded.
- The endpoint belongs to the account domain and **accepts only the OAuth token** (desktop app or plugin sign-in); a JWT answers `1016 invalid api key`. The read rides the credits poller with independent failure handling.
- Shown in the pill detail and the plugin page card; `tests/rate-limit.spec.ts` pins parsing, URL, failure handling and the polling wiring.
### 0.5.4 (2026-10-29)

- **Fixed long conversations being reported as context overflow**: upstream's `limit.context` (512,000) is the *default* window and the billing tier boundary, while the ceiling the gateway enforces is the 1,000,000 in `context_window_options`. Declaring 512,000 meant that once a conversation crossed that line, *every* turn was reported as `pi-ai detected context overflow` — even though the model answered normally and the reply was discarded. The window is now declared as the ceiling the gateway actually enforces.
- The built-in fallback roster (used when the catalog cannot be fetched) now declares 1,000,000 as well.
- Four new cases pin the window parsing: the largest of `context_window_options` wins, upstream's `limit.context` is the fallback, a malformed option list is ignored, and the fallback roster does not claim 512k.

### 0.5.3 (2026-10-25)

- **Fixed image input**: an upload used to fail every time — `pi-ai image input requires the durable attachment service` (`UNSUPPORTED_CONTENT`). The catalog always declared `image` among a model's input modalities, but the plugin built its `PiAiAdapter` without `resolveAttachments` or `resolveImageAccess`, so pi-ai had no way to turn a durable attachment reference into request bytes and refused the call before it reached the gateway. The plugin now reads the host's `attachments` service on demand and maps an attachment's host path into the current execution world with `fs.processPathFromHostPath`; a host that offers no attachment service gets `undefined` for both hooks, and text-only calls are unchanged.
- New `tests/image-input.spec.ts` pins how both hooks resolve, the path mapping, and the "no attachment service still loads" case; `peerDependencies` gains `@deepseek-ai/dsh-attachment`.
- Measured against the live gateway: a 2×2 PNG sent to `M3.1-Flash` came back answered correctly (`inputTokens: 316`).

### 0.5.2 (2026-10-21)

- **An icon for the plugin page**: a new `icon.svg` (48×48, under 800 bytes) ships with the package, declared as `"icon": "./icon.svg"` in `package.json`. The host reads it as a data URL and draws it on the plugin page instead of the default placeholder.
- **Chinese and English title and introduction**: new `locale/en.json` and `locale/zh.json` (the host reads the language files in the package root's `locale/` directory, with the English file as the anchor). The plugin page used to show the package name `dsh-connect-minimaxcode` and the mixed-language description from package.json; the title is now `DSH Connect MiniMax Code` and the introduction comes in both languages.
- **The interface follows the host's language**: neither the composer nor the plugin-page slot carries a translator in its standard props, so the copy always came from the built-in Chinese fallback — Chinese labels even in an English host. The bound locale is now injected into both slots, so an English host shows English.
- `exports` gains `./locale/*` (the host resolves the language files through it) and `files` gains `locale` and `icon.svg`.

### 0.5.1 (2026-10-20)

- **The balance follows the selected model**: moved from the dock below the input box to the **composer tool row beside the model picker**, gated by the host's `modelSelection` projection — the readout is drawn **only while a `minimaxcode` model is selected**, and selecting another connector's model (workbuddy, for instance) hides it entirely, polling included (following `dsh-connect-trae`).
- **`engines.dsh` narrowed to `>=0.2.1-rc.2 <0.3.0-0`**: only the tier actually tested is claimed; the previous `>=0.1.7-rc.1` reached too far.

### 0.5.0 (2026-10-20)

- **Added "sign in on your own"**: the plugin can sign in to MiniMax Code with the OAuth device code flow, so it no longer depends on the desktop app being installed and signed in. You confirm in your own browser, the plugin never sees a password, and the credential lives in the plugin's own file rather than the client's directory.
- **Added "daily check-in"**: reads the upstream seven-day cycle (400/400/400/1000/400/400/1000 = 4000 credits per round), shows the day's state and the expiring grants, and offers a manual "Claim" and a "Claim daily on its own" switch that is **off by default**.
- **Corrected by measurement**: the `mmoat_` token works against **both** the model gateway and the account endpoints (the previous documentation said the OAuth token was refused by the gateway — that was wrong), so one sign-in covers models, credits and the check-in.
- The plugin now mounts two routes: the status route the card reads, and a POST route for the actions (claim, sign-in, the setting), which is **loopback-only**.

### 0.4.2 (2026-10-19)

- **Discoverability**: the npm description is now bilingual, the keywords were completed (`dsh`, `credits`, `usage`, …), and the repository description and topics were updated to match.
- Added `awesome-dsh-plugin-submission/` to the repository: the market entry draft and the rules it has to follow.
- Added an English README ([README.en.md](README.en.md)).

### 0.4.1 (2026-10-19)

- **Fixed the ledger paging parameter**: the endpoint **accepts** `page` and then **ignores** it; the parameter it actually reads is `page_number`. An account with more than a hundred lots used to collect the same page over and over.
- **Corrected the expiry rule**: "29 days after the grant" was an artifact of reading a UTC grant time against a UTC expiry time. The real rule is **thirty calendar days after the day it was granted** (at midnight in the account's own timezone). Some lots run a full year, so the expiry is always read from the response's `expire_at_ms`.
- Two statements were corrected as well: expiry does **not** zero a lot's `remaining_amount` (it can leave a small negative residue) — it excludes the expired lot from the balance instead; and the ledger total equals the balance digit for digit while the account is idle, so a difference between two samples is real consumption in between.

### 0.4.0 (2026-10-19)

- **Added "credits about to expire"**: credits are granted one lot at a time and each lot expires on its own (thirty calendar days after the day it was granted). The plugin reads the credit ledger `GET /minimax-cloud/api/v1/credit/details` and shows, in the **plugin page** and in the pill, the credits expiring within 7 days and within 30 days, the nearest expiry date, and a list of expiring lots.
- **Only lots that still have a balance are counted**, so that lots which are "used up but about to expire" are not counted as a loss.
- **Plugin page card**: a new card under "Settings → Plugins → DSH Connect MiniMax Code" (balance, granted/purchased split, expiry distribution, expiring lots, consumption on this machine and equivalent cost); the list itself shows a one-line summary.
- **The pill and the card share one state store and one poller**, so multiple interfaces do not request the account API repeatedly.

### 0.3.0 (2026-10-19)

- **Added the credit balance display**: the pill under the composer input box shows the remaining MiniMax Code credits (granted/purchased split); expanding it shows the consumption between two reads, the tokens accumulated on this machine, and the equivalent cost converted at the official price list.
- **Added usage metering**: the `usage` of every request is taken from the upstream response itself, accumulated locally and converted into money.
- **Located the account API**: found the `POST /matrix/api/v1/commerce/get_membership_info` the desktop app really calls every day, and **overturned the 0.2.x conclusion that the quota could not be displayed** — the reason is at the end of "Credit balance and usage".
- **Adjusted the token strategy**: the model gateway uses the JWT, the account API uses the desktop app's OAuth token; when the latter expires, the plugin refreshes it with the refresh token the app already stored and writes it back in the client's original format, which leaves the desktop app's login state intact.
- **First release with a browser-side plugin**: adds `lib/client.js` (a classic script) that registers a single composer dock pill. **A DSH restart is required after the upgrade**.

### 0.2.3 (2026-10-19)

- **Synced with upstream model changes**: MiniMax retired the two older models `M2.7` and `M2.7-highspeed`; the test model that had been rolling out anonymously (codename "space bunny" / 太空兔) was released as **`M3.1-Flash`**. The current live upstream catalog is `M3` and `M3.1-Flash`.
- The built-in fallback list and the documentation were updated accordingly. **Signed-in users see the model change without updating the plugin** (the list comes from the live upstream catalog); this release only brings the signed-out fallback, the tests and the docs in line with upstream.

For earlier versions, see [GitHub Releases](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/releases) and the [npm version list](https://www.npmjs.com/package/dsh-connect-minimaxcode?activeTab=versions).

## Marketplace listing and presentation

The plugin ships an installable `dsh.bundle` manifest and is published to npm — **npm is the installation path**:

```bash
dsh plugin --profile desktop add dsh-connect-minimaxcode
```

The directory of the community plugin marketplace (`dshmarket`) is generated from the [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry, and this plugin's entry is in it ([#8110](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8110) listed, [#8380](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8380) refreshed), so it also shows up in the DSH plugin centre.

**Other directories**: entries were submitted to several awesome lists as well, but those projects see little maintenance; the entries and the forks opened for them have been cleaned up and are **no longer maintained**. Distribution runs through npm and this repository's Releases.

| Channel | State |
|---|---|
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (the registry behind `dshmarket`) | Listed |
| [dshbase](https://github.com/ylwl1997/dshbase) | Listed (automatic scan) |
| Other awesome lists | No longer maintained; entries and forks cleaned up |

Marketplace screenshots are declared, per the current convention, by the **`screenshots.json` in the plugin's own repository root** (the registry's `data/screenshots.json` is a fallback from the old convention, and no new keys are added there). This repository **does not ship screenshots yet**, so the file does not exist; once there are some, put `screenshots.json` in the repository root (an array of relative image paths) and the marketplace card will pick them up.

> **Since 0.5.1 the readout lives in the composer tool row (beside the model picker) and is gated by the host's `modelSelection` projection**: the balance belongs to the provider the next request will actually use, so it sits where that selection is made — and it hides entirely, polling included, when another connector's model (dsh-connect-workbuddy, for example) is selected. This follows `dsh-connect-trae`, whose `ComposerPointsGate` returns null for every provider but its own.
>
> The tool row is a shared slot and can in principle be crowded out (a sibling plugin lost a reading this way in `workbuddy` issue #62; trae's answer is a second seat). **This plugin registers the tool-row seat only**; the ambient dock is a proven fallback should crowding ever occur.

## Uninstall

```bash
dsh plugin --profile desktop remove dsh-connect-minimaxcode
```

## Development

```bash
pnpm install
pnpm test        # unit tests + host integration tests
pnpm typecheck   # type check
pnpm build       # build
```

The build depends on `@earendil-works/pi-ai`, which must resolve to the same version as the host's `dsh-llm-pi-ai` (currently `0.85.x`), otherwise the types are incompatible.

The UI half (`src/client.ts`) is compiled separately by `tsconfig.client.json` into a **classic script** (`lib/client.js`): the host loads the client bundle with a `<script>` tag, and an ESM output would break Web startup outright (`Cannot use import statement outside a module`), so there is deliberately no bundler here and no bundled React — React comes from the host's browser module table.

**`lib/` is build output that is tracked in version control**, not a generated artifact. This is deliberate: a git-source install gets the repository content as it is, and without `lib/` pnpm decides the package "needs to be built" and triggers `prepare`, which is then blocked by the build-script allowlist. After changing the source, rebuild and commit:

```bash
pnpm build && git add lib
```

## Similar plugins

These plugins follow the same idea — **reuse the login state your local desktop app already has and bring the model into DSH** — with no separate API key to configure. They were written independently by different authors and are not affiliated with this project.

| Plugin | Data source | Daily check-in for free quota | Quota / usage display |
|---|---|---|---|
| **dsh-connect-trae** | Trae (China + international) | ✅ China region | ✅ Work / general credit overview |
| **dsh-qoder-connect** | Qoder (China + international, PAT) | ✅ 100 Credits per day | ✅ Sidebar quota card + breakdown |

> Each plugin's check-in rules, quota basis and limitations are defined by its own documentation. The readings above come from the same machine and only represent the state at that time; they are not a promise.

### [dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae)

Connects a locally signed-in Trae to DSH; the China and international versions can be used at the same time. The China version supports a daily check-in to claim credits, and provides a read-only overview of Work / general credits. Note that Trae's check-in is limited to "once per device per day".

```bash
dsh plugin --profile desktop add dsh-connect-trae
```

### [dsh-qoder-connect](https://github.com/masknull/dsh-qoder-connect)

Connects Qoder through a personal access token (PAT), with independent configuration for the two regions. It signs in automatically every day to claim 100 Credits of compute quota, the check-in time can be customized (10:00 by default, UTC+8), and it makes up for a missed check-in on startup; it also shows the quota in the sidebar with a per-package breakdown.

```bash
dsh plugin --profile desktop add dsh-qoder-connect
```

## Contributors

- **[eghrhegpe](https://github.com/eghrhegpe)** — raised the request for a plugin-page icon and Chinese/English copy ([#1](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/issues/1)). It became 0.5.2: the plugin page has its own SVG artwork, the title and the introduction come in both languages, and the interface follows the host's language.
- **[azsora](https://github.com/azsora)** — found the plan's rate-limit endpoint in the desktop app's own traffic and wired the 5-hour and weekly usage windows into the credit pill and the plugin page ([#4](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/pull/4)): the window length is derived from the response's own edges rather than hard-coded. It became 0.5.5.
- **[qzz19970504](https://github.com/qzz19970504)** — found and fixed the wiring gap that made every image upload fail ([#3](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/pull/3)): the catalog declared the `image` modality, but the adapter never connected the host's durable attachment service, so pi-ai refused image requests before they were sent. The fix became 0.5.3.
- Plugin author: **[JeffTsuiCUG](https://github.com/JeffTsuiCUG)**

## Acknowledgements

- **[dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)** — another implementation in the same direction; this plugin's **plugin structure and provider registration** follow it.
- [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) — the same author's DSH plugin, useful as a reference for the DSH plugin structure.

> The projects listed under "Similar plugins" are the work of independent developers. They are not affiliated with or endorsed by this project, and each one follows its own license and disclaimer.

## License

[MIT](./LICENSE)
