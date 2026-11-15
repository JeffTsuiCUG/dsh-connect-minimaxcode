/**
 * The upstream protocols this plugin speaks, as they were measured.
 *
 * Each file records one upstream surface: the endpoints, the shape of what
 * comes back, and — most importantly — what was actually observed, with the
 * date it was observed. The upstream is not under this project's control and
 * may change, so a reader needs to know how old a measurement is before
 * trusting it.
 *
 * Nothing here is read at runtime. These are notes for whoever works on the
 * plugin next, and for whoever reads a bug report about a field they do not
 * recognise.
 */

# Upstream protocols

| Document | What it covers |
| --- | --- |
| [H3-GENERATION.md](H3-GENERATION.md) | The H3 image and video endpoints: requests, answers, the accounting, and what a refusal looks like. |
| [ACCOUNT-ENDPOINTS.md](ACCOUNT-ENDPOINTS.md) | The account endpoints: the membership answer, the credit ledger, the plan's limit windows, and the usage profile. |
| [CREDENTIALS.md](CREDENTIALS.md) | Where the login state comes from, and the two paths it can arrive by. |
| [ERROR-TAXONOMY.md](ERROR-TAXONOMY.md) | How a failure is classified, and why the classification is by shape rather than by code. |

## How a measurement is recorded

Every fact here carries the date it was measured and the endpoint it came
from. Two reasons:

- the upstream answers differently over time — the plan's window fields were
  renamed and their meaning inverted between one release and the next, and a
  note without a date would have said the wrong thing for months;
- a reader who wants to reproduce a measurement needs to know which build and
  which account it came from, because an account without a plan gets a
  different answer than one with it.

A measurement that has not been repeated in a long time is treated as a
hypothesis, not as a fact. The ones below were measured against the account
this plugin was developed with, in the region named in each document.
