# H3 image and video generation

The upstream endpoints this plugin calls to make a picture or a video with
H3, as measured on **2026-11-12** against the account this plugin was
developed with, in the **China** region.

Everything here was observed, not read from documentation — the endpoints are
not documented publicly. Where a measurement could be repeated, it was.

## Credentials

The generation endpoints do **not** take the OAuth bearer the model gateway
takes. They take the **open-platform key**, which the account's own credit
endpoint hands out:

```
GET https://www.minimaxi.com/backend/account/token_plan_credit?business=Agent&device_platform=desktop
Authorization: Bearer <the desktop app's OAuth token>
```

The answer carries `api_key` — a `sk-cp-…` value — and the plugin keeps it
for as long as it runs. Passing the OAuth token instead is refused with
`1004 login fail: Please carry the API secret key`, which arrives with
HTTP 200 and a code in the body.

## Images

```
POST https://api.minimax.cn/v1/images/generations
Authorization: Bearer <the open-platform key>
Content-Type: application/json
```

The request carries `model`, `prompt`, `response_format`, and optionally
`n`, `aspect_ratio` and `area`.

| Model | Note |
| --- | --- |
| `MiniMax-H3-Image` | the default |
| `MiniMax-H3-Image-Highspeed` | the faster one |

The answer carries `data[]` with either a `url` (valid for **24 hours**) or
`b64_json`. It also carries `usage.generated_images`, `usage.total_tokens`
and a `request_id`.

The plugin downloads the bytes while the link is still fresh, because a
plugin that kept only the link would leave the picture behind.

## Videos

```
POST https://api.minimax.cn/v2/video_generation
```

The request carries `model` and a `content[]` array whose entries are
`{type: 'text'}`, `{type: 'image_url', image_url: {url}, role: 'first_frame' | 'last_frame'}`.
`duration` is 4–15, `resolution` is `768P` or `2K`, and `ratio` runs from
`21:9` to `9:16`.

The answer carries a `task_id`; the state is read from:

```
GET https://api.minimax.cn/v2/query/video_generation/{task_id}
```

whose answer carries `task.status` (`running`, `succeeded`, and the failure
spellings), `task.content.url`, `task.resolution`, `task.duration`,
`task.ratio` and `task.usage.total_seconds`.

The v1 path answers "该模型请使用 /v2/video_generation 接口" — the model moved
to v2, and the old path says so.

## What a refusal looks like

**A refusal can arrive with HTTP 200.** The body carries `base_resp` with a
`status_code` that is not zero. Reading only the HTTP status would call
these a success.

| Code | Meaning, as observed |
| --- | --- |
| `1004` | the credential was refused (`login fail`) |
| `2013` | a parameter was refused; the message names the field |
| `2062` | `no active token plan subscription` — the account has no plan |

The plugin classifies these by shape, not by number: see
[ERROR-TAXONOMY.md](ERROR-TAXONOMY.md).

## What was charged

The plugin distinguishes two failures, because the difference decides whether
a retry is sensible:

- a failure **before** the upstream accepted the work (a bad parameter, a
  refused credential, a request the plugin refused to send) spent nothing
  and may be retried at once;
- a failure **after** the upstream accepted it — a video task that was
  submitted and then could not be read back — may already have been charged
  for, and a retry is another task and another charge.

The plugin says which of the two happened, in the same place it shows the
upstream's own words.

## Not measured

- Whether the 24-hour link can be refreshed rather than re-generated.
- What a partially completed video task costs.
- The international region's endpoints on this protocol: the same paths are
  used against `api.minimaxi.com`, but nothing here was measured against
  that region.
