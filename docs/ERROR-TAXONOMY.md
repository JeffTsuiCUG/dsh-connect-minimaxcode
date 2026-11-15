# How a failure is classified

The plugin turns an upstream refusal into three things a person can act on:
**what kind of failure it is**, **whether it may already have been charged
for**, and **the upstream's own words**.

## Why the classification is by shape

The upstream's failures arrive in several shapes: an HTTP status, a business
code, a sentence, sometimes all three. The obvious thing to key on is the
code — `2013` means a bad parameter, `2062` means no plan.

**The plugin does not.** It keys on the *shape* of the failure: the HTTP
status and the wording.

The reason is that a code is a number **some other system chose**. It may be
renamed, or withdrawn, or reused for something else, and a classifier that
keyed on it would one day quietly stop matching — the plugin would report
"something went wrong" for a failure it used to recognise, with no sign
that anything had changed. A classifier that keyed on the *kind* of failure
keeps working across renames, and only has to be extended when a genuinely
new kind appears.

This is the same rule the plugin follows elsewhere: a fact that travels with
the **data** may be relied on; a fact that travels with another system's
**code** may not.

## The kinds

| Kind | Recognised by | The remedy |
| --- | --- | --- |
| `credentials` | HTTP 401 / 403, or wording about a refused key or a failed sign-in | sign in again |
| `parameters` | HTTP 400 / 422, or wording about an invalid or unsupported value | change the request |
| `subscription` | wording about no active plan or subscription | check the plan |
| `quota` | wording about an insufficient balance or a spent quota | wait, or check the windows |
| `rate-limited` | HTTP 429, or wording about too many requests | wait |
| `upstream` | anything else | show the upstream's words and ask for a report |
| `local` | the request never left the plugin | fix it and try again |

**A failure that is not recognised is not guessed at.** It becomes
`upstream`, whose remedy is to show the upstream's own words — which is what
a report needs, and better than a confident wrong answer.

**The wording is checked before the status**, except for the two statuses
that name a class outright (401/403 and 429). The reason is that a bad
request can arrive for a reason that is not a bad request: the "no active
subscription" refusal arrives as HTTP 400, and telling the reader to change
the parameters would send them looking in the wrong place.

## What it cost

A failure that happened **before** the upstream accepted the work spent
nothing: a bad parameter, a refused credential, a request the plugin
refused to send. A retry after fixing something is free, and the plugin says
so.

A failure that happened **after** the upstream accepted the work — a video
task that was submitted and then could not be read back — may already have
been charged for. The plugin says so too, and holds off for a while.

## What the reader sees

Three lines, in this order:

1. **the remedy**, in the host's language;
2. **a warning when the work may have been charged for**;
3. **the upstream's own words**, collapsed — they are read when a report is
   being written, not when the failure happens.

The upstream's words are shown **as they arrived**. A paraphrase would be a
guess about what the upstream meant, and the guess would be the thing a
reader would quote back.
