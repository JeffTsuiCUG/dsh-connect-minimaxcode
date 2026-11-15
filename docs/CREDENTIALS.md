# The credentials, and where they come from

The plugin can be signed in two ways, and they arrive by different paths.
Which one is in use is what the card reports as its sign-in source.

## The desktop app's login (the usual one)

The MiniMax Code desktop app leaves its login state in a file. The plugin
reads it and never writes it.

The file's location is probed per platform, and the card lists every path it
tried and why each one did not work — five distinct reasons, so that the
commonest misdiagnosis ("the app is not signed in") is not mistaken for
"the file is somewhere else".

The desktop app's token is what the **model gateway** takes:

```
POST https://agent.minimax.cn/mavis/api/v1/llm/v1/messages
Authorization: Bearer <the desktop app's OAuth token>
```

It is also what the **account endpoints** take — membership, the credit
ledger, the usage profile, and the credit-package summary that hands out the
open-platform key.

## The plugin's own login (the fallback)

With no desktop app on the machine, the plugin starts an OAuth device flow
from the card and keeps its own token under the Harness home. The person
confirms it in a browser.

That token serves the model gateway and the account endpoints too. The
**generation** endpoints do not take it — they take the open-platform key,
which the credit-package summary hands out.

## The open-platform key

```
GET https://www.minimaxi.com/backend/account/token_plan_credit?business=Agent&device_platform=desktop
```

The answer carries `api_key`, a `sk-cp-…` value. The plugin keeps it for as
long as it runs and never writes it to disk.

Passing the OAuth token to the generation endpoints instead is refused with
`1004 login fail: Please carry the API secret key`.

## The two paths that failed before

Both of these were real, and both are why the plugin reads the account
endpoints at all:

- **The model gateway read only the legacy JWT.** It now falls back to the
  desktop app's OAuth credential, and a re-login takes effect without
  restarting the host.
- **The credit endpoint was answered with an empty body.** The plugin now
  reads the documented endpoints, and the answer's own summary.

## What the plugin never does

- It never writes to the desktop app's files.
- It never prints a token. The plugin's own state file holds the OAuth
  credential; the open-platform key is held in memory only.
- It does not start a login of its own unless the card is pressed.
