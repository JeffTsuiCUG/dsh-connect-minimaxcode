# DSH Connect MiniMax Code (`dsh-connect-minimaxcode`)

Bring the models of the **MiniMax Code desktop app (China region)**, already signed in on this machine, into **DeepSeek Harness (DSH)**. Install it and it works — there is no API key to configure.

![license](https://img.shields.io/badge/license-MIT-blue.svg)
[![version](https://img.shields.io/npm/v/dsh-connect-minimaxcode?color=cb3837)](https://www.npmjs.com/package/dsh-connect-minimaxcode)
[![CI](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/actions/workflows/ci.yml/badge.svg)](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/actions/workflows/ci.yml)

[简体中文](README.md) | English

## Inspiration

The idea for this plugin came from **[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)** (by Corrine Hu).

That project was the first to show that **a model already signed in on a desktop app can be moved into DSH with zero configuration** — no handling of accounts or passwords, no new authentication scheme; it just attaches a provider to the login state the machine already has and reuses DSH's built-in provider adapter. This plugin applies the same approach to MiniMax Code:

| | dsh-workbuddy-connect | This plugin |
|---|---|---|
| Data source | Local login state of the WorkBuddy desktop app | Local login state of the MiniMax Code desktop app |
| Integration | Registers a DSH provider and exposes the already-signed-in models | Same |
| Catalog source | Live model list from upstream | Same |

Another implementation in the same direction is **[dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)**; for **how the plugin is structured and how the provider is registered**, this plugin also follows the same author's [dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) (whose connection core itself references corrinehu's implementation — see the acknowledgements in its README).

> The two differ in this way: **corrinehu was the original pioneer** — the "reuse the local login state" route was established by that project; **dingminhua's implementation follows the existing conventions of the DSH plugin structure more closely**, and this plugin's directory layout and `cordis.patch.yml` follow the latter. Both are credited at the end of this document.

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
- **The device code flow needs `account.minimax.cn` to be reachable**, and the browser that authorizes it has to be able to sign in to a MiniMax account. On some restricted networks the authorization page cannot be opened.

## Changelog

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
- Added [`awesome-dsh-plugin-submission/`](awesome-dsh-plugin-submission/) to the repository: the market entry draft and the rules it has to follow.
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

The plugin ships an installable `dsh.bundle` manifest and is published to npm. The directory of the community plugin marketplace (`dshmarket`) is generated from the [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry, and this plugin's listing has been submitted as PR [#8110](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8110). A draft and the operating notes are kept in the repository: [`awesome-dsh-plugin-submission/`](awesome-dsh-plugin-submission/).

**Other directories and marketplaces** (entries submitted or already listed, text refreshed to 0.5.1):

| Channel | State |
|---|---|
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (the registry) | Listed; entry refresh PR [#8380](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8380) |
| [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) | PR [#727](https://github.com/0xsline/awesome-deepseek-harness/pull/727) |
| [Awesome-DeepSeek-Harness-Plugins](https://github.com/Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins) | PR [#92](https://github.com/Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins/pull/92) |
| [dsh-suite](https://github.com/whyihaveyou/dsh-suite) | PR [#66](https://github.com/whyihaveyou/dsh-suite/pull/66) |
| [awesome-dsh-plugins](https://github.com/kejixiaoliang/awesome-dsh-plugins) | PR [#143](https://github.com/kejixiaoliang/awesome-dsh-plugins/pull/143) |
| [awesome-dsh-plugins](https://github.com/dshworks/awesome-dsh-plugins) | PR [#176](https://github.com/dshworks/awesome-dsh-plugins/pull/176) |
| [awesome-deepseek-harness](https://github.com/awesome-deepseekharness/awesome-deepseek-harness) | PR [#177](https://github.com/awesome-deepseekharness/awesome-deepseek-harness/pull/177) |
| [dsh-plugin-radar](https://github.com/AdamPlatin123/dsh-plugin-radar) | PR [#964](https://github.com/AdamPlatin123/dsh-plugin-radar/pull/964) |
| [dsh-community-plugins](https://github.com/zhu1090093659/dsh-community-plugins) | PR [#46](https://github.com/zhu1090093659/dsh-community-plugins/pull/46) |
| [dsh-plugin.org](https://github.com/dshplugin/dsh-plugin-hub) | Listed (automatic scan; the npm package shows up in the DSH plugin centre) |
| [dshbase](https://github.com/ylwl1997/dshbase) | Listed |
| [awesome-deepseek-harness-plugins](https://github.com/walkinglabs/awesome-deepseek-harness-plugins) | PR [#117](https://github.com/walkinglabs/awesome-deepseek-harness-plugins/pull/117) |
| [awesome-deepseek-harness](https://github.com/Dominic789654/awesome-deepseek-harness) | PR [#663](https://github.com/Dominic789654/awesome-deepseek-harness/pull/663) |
| [awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) | PR [#660](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/pull/660) |

Marketplace screenshots are declared, per the current convention, by the **`screenshots.json` in the plugin's own repository root** (the registry's `data/screenshots.json` is a fallback from the old convention, and no new keys are added there). This repository **does not ship screenshots yet**, so the file does not exist; once there are some, put `screenshots.json` in the repository root (an array of relative image paths) and the marketplace card will pick them up.

> **Since 0.5.1 the readout lives in the composer tool row (beside the model picker) and is gated by the host's `modelSelection` projection**: the balance belongs to the provider the next request will actually use, so it sits where that selection is made — and it hides entirely, polling included, when another connector's model (workbuddy, for example) is selected. This follows `dsh-connect-trae`, whose `ComposerPointsGate` returns null for every provider but its own.
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
| **dsh-workbuddy-connect** | WorkBuddy (China + international) | — | ✅ Remaining credits + breakdown |

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

### [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)

Connects the WorkBuddy desktop app; the China and international versions can coexist, each using its own account and its own credits. It shows the account information, token validity and remaining credits, and ships a CLI:

```bash
dsh plugin --profile web exec dsh-workbuddy-connect status
```

> This plugin's version must match your DSH core exactly (each core line uses a different version); see the version table in its README before installing.

## Contributors

- **[eghrhegpe](https://github.com/eghrhegpe)** — raised the request for a plugin-page icon and Chinese/English copy ([#1](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/issues/1)). It became 0.5.2: the plugin page has its own SVG artwork, the title and the introduction come in both languages, and the interface follows the host's language.
- **[qzz19970504](https://github.com/qzz19970504)** — found and fixed the wiring gap that made every image upload fail ([#3](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/pull/3)): the catalog declared the `image` modality, but the adapter never connected the host's durable attachment service, so pi-ai refused image requests before they were sent. The fix became 0.5.3.
- Plugin author: **[JeffTsuiCUG](https://github.com/JeffTsuiCUG)**

## Acknowledgements

- **[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)** — **the inspiration for this plugin**. The overall idea of "reuse the desktop app's local login state and bring the already-signed-in model into DSH" was established first by that project, and this plugin follows the same approach; the read-only reuse of credentials was designed with it in mind.
- **[dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)** — another implementation in the same direction; this plugin's **plugin structure and provider registration** follow it (its connection core also references corrinehu's implementation — see that project's acknowledgements).
- [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) — the same author's DSH plugin, useful as a reference for the DSH plugin structure.

> The projects listed under "Similar plugins" are the work of independent developers. They are not affiliated with or endorsed by this project, and each one follows its own license and disclaimer.

## License

[MIT](./LICENSE)
