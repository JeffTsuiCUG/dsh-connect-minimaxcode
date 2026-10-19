# DSH Connect MiniMax Code (`dsh-connect-minimaxcode`)

Bring the models of the **MiniMax Code desktop app (China region)**, already signed in on this machine, into **DeepSeek Harness (DSH)**. Install it and it works — there is no API key to configure.

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![version](https://img.shields.io/badge/version-0.2.3-cornflowerblue.svg)
[![npm](https://img.shields.io/npm/v/dsh-connect-minimaxcode?color=cb3837)](https://www.npmjs.com/package/dsh-connect-minimaxcode)
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
- **Credit balance at a glance**: the pill under the input box shows the remaining MiniMax Code credits and the consumption accumulated on this machine
- **Live usage accounting**: the token usage of every request is taken from the upstream response itself, and can be converted to an equivalent cost using the official price list
- **Reuses the official adapter**: upstream speaks the standard Anthropic Messages protocol, so DSH's built-in provider is reused as is; tool calls, reasoning blocks and context compaction are all handled by DSH
- **Read-mostly**: apart from "refreshing an expired desktop app login state", the plugin does not write to or modify any MiniMax file, and does not perform any login action
- **Non-intrusive UI**: the pill takes a single row in the dock under the input box, and changes nothing else in the DSH interface

## Prerequisites

1. The MiniMax Code desktop app (China region) is installed and **signed in**
2. DSH desktop (built-in core in the `0.2.0` series) or the Web profile

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

After installing, **no restart is needed** — the plugin hot-reloads, and the models then show up under the **MiniMax Code** group in the model picker.

> The UI pill (credit balance) is a browser-side plugin, so **the first install, or an upgrade to 0.3.0, requires one DSH restart** before it appears under the input box.

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

## Credit balance and usage

The pill under the composer input box shows the **remaining MiniMax Code credits**; expanding it also shows the granted/purchased split, the consumption between the two reads, and the tokens and equivalent cost accumulated on this machine.

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

Based on that, the plugin shows, in the **plugin page** (Settings → Plugins → DSH Connect MiniMax Code) and in the pill under the input box:

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
- **When the OAuth token expires the credit pill is temporarily unavailable**; open the MiniMax Code desktop app once and let it refresh itself (or wait for the plugin's refresh to succeed). This does not affect model traffic.
- **No settings card is provided**. The plugin does not register a card on the DSH settings page; the only interface change is a single pill under the input box.
- **The upstream APIs are non-public** and may stop working when MiniMax updates its client. If the balance API breaks, the pill shows "credits unavailable", which does not affect model traffic.

## Changelog

### 0.4.0 (2026-10-19)

- **Added "credits about to expire"**: credits are granted one lot at a time and each lot expires on its own (about 29 days after it was granted). The plugin reads the credit ledger `GET /minimax-cloud/api/v1/credit/details` and shows, in the **plugin page** and in the pill, the credits expiring within 7 days and within 30 days, the expiry date of the most recent lot, and a list of expiring lots.
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

Marketplace screenshots are declared, per the current convention, by the **`screenshots.json` in the plugin's own repository root** (the registry's `data/screenshots.json` is a fallback from the old convention, and no new keys are added there).

> The UI pill sits in the **dock below the input box** rather than in the input box toolbar: the toolbar is a **shared slot** where the shell's own controls and other plugins all register, and there is no way to guarantee that every occupant is visible — a sibling plugin once lost a reading for exactly that reason.

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

## Acknowledgements

- **[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)** — **the inspiration for this plugin**. The overall idea of "reuse the desktop app's local login state and bring the already-signed-in model into DSH" was established first by that project, and this plugin follows the same approach; the read-only reuse of credentials was designed with it in mind.
- **[dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)** — another implementation in the same direction; this plugin's **plugin structure and provider registration** follow it (its connection core also references corrinehu's implementation — see that project's acknowledgements).
- [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) — the same author's DSH plugin, useful as a reference for the DSH plugin structure.

> The projects listed under "Similar plugins" are the work of independent developers. They are not affiliated with or endorsed by this project, and each one follows its own license and disclaimer.

## License

[MIT](./LICENSE)
