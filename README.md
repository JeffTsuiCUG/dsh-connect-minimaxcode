# DSH Connect MiniMax Code (`dsh-connect-minimaxcode`)

把本机已登录的 **MiniMax Code 桌面 App（国内版）** 的模型接入 **DeepSeek Harness（DSH）**，装好即用，无需配置 API Key。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
[![version](https://img.shields.io/npm/v/dsh-connect-minimaxcode?color=cb3837)](https://www.npmjs.com/package/dsh-connect-minimaxcode)
[![CI](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/actions/workflows/ci.yml/badge.svg)](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/actions/workflows/ci.yml)

[English](README.en.md) | 简体中文

## 灵感来源

社区先走通了这样一条路：**桌面 App 已经登录的模型，可以零配置地搬进 DSH** —— 不去碰账号密码，不引入新的鉴权体系，只是把本机已有的登录态接上一个 provider，并复用 DSH 自带的 provider 适配器。本插件把同一套做法用在了 MiniMax Code 上：

| | 同类插件 | 本插件 |
|---|---|---|
| 数据来源 | 各自桌面 App 的本地登录态 | MiniMax Code 桌面 App 的本地登录态 |
| 接入方式 | 注册 DSH provider，暴露已登录模型 | 同左 |
| 目录来源 | 上游实时模型列表 | 同左 |

同方向已有多个实现，本插件在**插件结构与 provider 注册的组织方式**上参考了 **[dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)** 与同一作者的 [dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae)。

> 同类项目各自独立开发，与本项目无隶属关系。本插件的目录布局与 `cordis.patch.yml` 写法沿用了 DSH 插件结构的既有约定。

---

## ⚠️ 重要声明（请先阅读）

- **本项目仅供学习与研究使用**，不面向生产环境，也不提供任何商业支持。
- **本项目为非官方插件**，与 MiniMax、DeepSeek 均无关联，未获其认可或授权。
- 本插件仅**读取你自己本机上 MiniMax Code 已登录的凭证**，仅驱动**你自己的账号在你自己的电脑上**调用。
- **禁止**将本插件用于商业用途、超出个人合理使用范围的场景，或任何批量/多账号/规避限额的目的。
- 本插件依赖 MiniMax 客户端的**非公开接口**。MiniMax 更新客户端后，接口可能变更导致插件失效。
- 使用者需自行遵守 [MiniMax 的服务条款](https://agent.minimax.cn/doc/zh/terms-of-service.html)。因使用本插件产生的一切后果（账号受限、额度清空、服务中断等）由使用者自行承担。
- 本项目作者不对任何因使用或不当使用本插件造成的直接或间接损失负责。

---

## 特点

- **零配置**：自动读取 MiniMax Code 桌面 App 的登录态，不在 DSH 中存储任何明文 Token
- **动态模型目录**：从上游接口实时拉取，模型增减无需更新插件
- **积分余额可见**：在输入框工具行（模型选择器旁）的胶囊里显示 MiniMax Code 的剩余积分，以及本机累计消耗
- **实时消耗统计**：每次请求的 token 用量取自上游响应本身，可按官方价目表折算等效金额
- **复用官方适配器**：上游为标准 Anthropic Messages 协议，直接复用 DSH 自带 provider，工具调用、推理块、上下文压缩均由 DSH 托管
- **不用装桌面 App 也能用**：插件可以自己走 OAuth 设备码流登录，你在自己的浏览器里确认即可，插件从不接触密码
- **每日签到**：MiniMax Code 每天送积分，客户端**不会自动领**；插件可以显示七天一签的进度，并代领当天的额度
- **只读为主**：除「续期已过期的桌面 App 登录态」和「你自己发起的登录」外，不写入、不修改 MiniMax 的任何文件
- **跟随所选模型**：余额显示在**输入框工具行（模型选择器旁）**，且**只在选中 MiniMax 模型时出现** —— 切到其他反代插件的模型就整体隐藏，不会拿着 MiniMax 的余额误导你
- **插件页有自己的图标与中英文**：随包发布一张 48×48 的 SVG，插件页不再显示默认占位图；标题与简介按宿主语言给中英文两版，界面文案也跟着宿主语言走
- **能看图**：模型目录里声明了 `image` 输入模态的模型（`M3`、`M3.1-Flash`）可以直接发图；图片由宿主的附件服务读成请求字节，插件只负责把持久化的附件引用接上去

## 前置条件

二选一：

1. **已安装并登录 MiniMax Code 桌面 App（国内版）** —— 插件直接复用它的登录态（最省事）
2. **什么都不装** —— 在插件页面点「登录 MiniMax Code」，插件发起 OAuth 设备码流，你在浏览器里用自己的 MiniMax 账号确认，插件拿到自己的登录态（需要能访问 `account.minimax.cn`）

另外需要 DSH 桌面版（内置内核 `>=0.2.1-rc.2 <0.3.0`，见 `package.json` 的 `engines.dsh`；实测 `0.2.1-rc.2`）或 Web profile。

> **发图需要宿主提供附件服务**：图片不是插件自己读的，而是由宿主的持久化附件服务读成请求字节，插件只负责把附件引用接上去。宿主没有附件服务时，插件照常加载、文本照常对话，只是发图会被拒绝（`pi-ai image input requires the durable attachment service`）。

## 安装

**方式一：从 Git 仓库安装**（推荐，拿到最新代码）

```bash
dsh plugin --profile desktop add github:JeffTsuiCUG/dsh-connect-minimaxcode
```

**方式二：npm 安装**（发布后可用）

```bash
dsh plugin --profile desktop add dsh-connect-minimaxcode
```

> **想立刻用上积分余额与到期提示**，请锁版本安装 —— pnpm 11 默认 `minimumReleaseAge` 为 1440 分钟，新版本发布后 24 小时内不带版本号的安装会解析到**较早的版本**（当前会落到 0.2.x，而积分功能是 0.3.0 才有的）：
>
> ```bash
> dsh plugin --profile desktop add dsh-connect-minimaxcode@0.4.2
> ```

Web profile 把 `--profile desktop` 换成 `--profile web`。

> **本地开发装自己改过的克隆**：不要把目录路径直接传给 `dsh plugin add`——pnpm 会以链接方式安装，把依赖的软链嵌进插件自己的 `node_modules`，宿主的插件沙箱 `stat` 这些链接会得到 `EPERM`，插件激活失败（`failed to import`）。先 `pnpm pack` 打成 tarball，再安装 tarball，依赖就会像 registry 安装一样解析在 profile 根 `node_modules`：

```bash
pnpm pack
dsh plugin --profile desktop add ./dsh-connect-minimaxcode-0.5.6.tgz
```
> 桌面版的 profile 由 Electron 应用独占，若 `dsh` 命令不在 PATH 中，请使用 DSH 应用自带的载体 CLI（路径随安装位置而变，例如 `<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd`）。

安装后插件会热加载，模型随后出现在模型选择器的 **MiniMax Code** 分组中。

> 积分胶囊与插件页面卡片属于浏览器侧插件，**首次安装、或升级到 0.3.0 及之后的版本后，需要重启一次 DSH** 才会出现（模型通路本身不需要重启）。

### 若安装被 `allowBuilds` 拦截

本仓库把构建产物 `lib/` 一并提交，因此正常情况下安装不会触发构建。若你看到：

```text
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package
```

说明你使用的是**某个早于 `0.2.1` 的提交**（那些版本尚未提交 `lib/`）。解决办法二选一：

- 改用上面写法指定版本：`github:JeffTsuiCUG/dsh-connect-minimaxcode#v0.2.1`
- 或在该 profile 的 `pnpm-workspace.yaml` 中加入 pnpm 提示的 `allowBuilds` 条目后重试

## 使用流程

1. **确认桌面 App 已登录**
   打开 MiniMax Code 桌面 App，确认处于已登录状态。插件读取的是 App 写入的本地登录态。

2. **安装插件**（见上一步的命令），等待热加载完成。

3. **选择模型**
   打开 DSH 的模型选择器，在 **MiniMax Code** 分组下选择模型。可用模型来自上游实时目录，例如 `M3`、`M3.1-Flash`。

4. **正常对话**
   直接使用即可。工具调用由 DSH 本地工具执行，插件只负责提供模型通路。

5. **令牌过期时重新登录**
   MiniMax Code 有**两份互不通用**的登录态，本插件各用其一：

   | 凭证 | 位置 | 有效期 | 用途 |
   |---|---|---|---|
   | JWT | `~/.minimax/local-runtime.auth.json` | 约 15 天 | 调模型网关（`/mavis/api/v1/llm/v1/messages`） |
   | OAuth（`mmoat_`） | `~/.minimax/auth/prod/<region>/mcode-public/auth.json` | 约 1 小时 | 读账户与积分（`/matrix/api/v1/commerce/get_membership_info`） |

   两份凭证互不通用：拿 JWT 打账户接口一律 `401`，拿 OAuth 令牌打模型网关同样不通。**模型对话**用 JWT，**积分显示**用 OAuth。

   | 现象 | 含义 | 处理方式 |
   |---|---|---|
   | 正常使用 | 两份凭证都有效 | — |
   | 模型报鉴权错误 | JWT 已失效 | 在 MiniMax Code 中**重新登录**，然后重启 DSH |
   | 积分胶囊显示「登录态已过期」 | OAuth 令牌过期 | 插件会用 App 自己的 refresh token 续期并写回；若续期失败，请打开一次 MiniMax Code 桌面 App 让它自行续期 |

   > OAuth 令牌过期**不会**影响模型对话：JWT 仍然有效，模型照常可用，只是积分胶囊暂时拿不到余额。
   >
   > 续期会**轮换** refresh token。插件因此把新的一对令牌按客户端**原格式原子写回**同一个文件，并保持 `generation` 不变——客户端靠它判断「这份凭据是否仍属于本次登录」，擅自抬高会让桌面 App 误判为异地登录。

### 关于响应速度

MiniMax 的这些模型**强制要求先推理再输出**，思考无法关闭。因此：

- 首个字符出现前会有一段等待（实测 M3.1-Flash 约 3 秒）
- 推理过程会以 `thinking` 块实时返回，可以在界面中看到模型"在想什么"
- 这是模型本身的行为，**不是插件造成的延迟**

若更看重流式体感的即时反馈，建议同时保留 DSH 官方模型或其他 provider 作为备选。

## 工作原理

1. 读取 `~/.minimax/local-runtime.auth.json`（MiniMax Code 写入的明文登录信息），**仅在内存中**解析其 JWT
2. 调用 `GET /mavis/api/v1/models` 获取实时模型目录（含上下文长度、多模态、工具调用等能力声明）
3. 注册 `minimaxcode` provider，指向 `POST /mavis/api/v1/llm/v1/messages`（标准 Anthropic Messages 协议）
4. 读取 `~/.minimax/auth/prod/<region>/mcode-public/auth.json` 的 OAuth 令牌，按需续期
5. 调用 `POST /matrix/api/v1/commerce/get_membership_info` 获取积分余额，通过插件自己的状态接口 `/plugins/dsh-connect-minimaxcode/status` 交给界面胶囊

### 与网关对接时的三个兼容处理

这些是实测中必须处理的差异，也是本插件与"直接改个 URL 就能用"的主要差异所在：

| # | 现象 | 处理 |
|---|---|---|
| 1 | 网关只认 `Authorization: Bearer`，而 pi-ai 默认发 `x-api-key`，后者单独出现会返回 `401 token is required` | 在模型描述符上附带 `Authorization` 头（网关同时接受两个头） |
| 2 | Anthropic SDK 会自己在 `baseUrl` 后追加 `/v1/messages`；若 `baseUrl` 已以 `/v1` 结尾，请求路径会变成 `/v1/v1/messages`，网关返回 `503 direct_route_not_configured` | `baseUrl` 收到版本段之前，由 SDK 补齐 |
| 3 | 所有模型强制要求推理，而"关闭推理"会让 pi-ai 发出 `thinking: {type: "disabled"}`，网关返回 `400 ... requires adaptive thinking` | 将"关闭"级别标记为不支持，使该字段被省略（网关接受） |

插件**不**包含任何硬编码的 Token、账号或接口密钥。

## 自己登录，不装桌面 App

插件可以自己完成登录，用的是 MiniMax Code 桌面端同一套 **OAuth 2.0 设备码流**（RFC 8628）：

1. 插件向 `account.minimax.cn/oauth2/device/code` 申请一个设备码，拿到一个 8 位用户码和授权页地址
2. 你在浏览器里打开那个地址，用**自己的 MiniMax 账号**登录并确认授权
3. 插件轮询 `oauth2/token`，拿到 `mmoat_` 令牌与 refresh token

要点：

- **插件不接触密码、也不接触验证码** —— 唯一的人工环节发生在你自己的浏览器里、账号官方的页面上
- **用了 PKCE**：设备码即使泄露，没有本进程里的 verifier 也换不成令牌
- **一枚令牌够用**：`mmoat_` 令牌既能调模型网关（`agent.minimax.cn/mavis/api/v1/llm`），也能调账户接口（积分、签到），所以登录一次就够
- **不写客户端的文件**：插件把凭据存在自己的 `~/.dsh/.minimaxcode-auth.json`（权限 0600，原子写）。桌面 App 的两个文件带 `generation` 计数器且必须同步递增，写进去会被它当成「在别处登录过」而要求重登
- **refresh token 会轮转**，插件把新的一对写回自己的文件，所以登录能长期有效

## 每日签到

MiniMax Code 的免费积分是**每天签到送的**，不是登录就送。客户端有个「每日签到」卡片，但**不会自动领** —— 卡片弹出来，得你自己点。

上游的接口是：

```
GET  /minimax-cloud/api/v1/signin/status?timezone_id=Asia/Shanghai   # 七天一轮的进度
POST /minimax-cloud/api/v1/signin/claim?timezone_id=Asia/Shanghai   # 领取当天额度
```

几点实测结论：

- **时区必须是 IANA 名字**（`Asia/Shanghai`）。传偏移量或干脆不传，服务端会回 `invalid timezone_id`
- **一轮七天**：400 / 400 / 400 / 1000 / 400 / 400 / 1000 = **4000 积分**
- **签到的积分 30 天有效**（响应里的 `expire_at_ms` 正好是领取日 + 30 天的北京时间零点）
- **按天幂等**：当天重复领返回 `claim_result: 2`（今日已领），不会重复发放

插件页面里能看到当天是第几天、值多少积分、一轮还剩哪些天，并提供两个动作：

- **「签到」按钮** —— 你点一下，插件领当天的额度
- **「每天自动签到」开关**（默认关） —— 打开后，插件在检测到「服务端说今天可领」时自动领一次，每天至多一次

自动签到刻意做得很克制：只在上游明确说当天可领时才发请求、当天至多一次、不并发重试、不绕过任何验证，出错就把原因显示出来而不是静默重试。请自行确认这样做符合 MiniMax 的服务条款。

## 积分余额与用量

输入框工具行（模型选择器旁）的胶囊会显示 MiniMax Code 的**剩余积分**；点开还能看到赠送/购买拆分、两次读取之间的消耗，以及本机累计的 token 与等效金额。胶囊**只在选中 `minimaxcode` 模型时出现**。

### 余额从哪里来

MiniMax Code 桌面 App 自己每天在调一个「会员信息」接口，响应里就带着客户端设置页显示的那三个数字：

```
POST https://agent.minimax.cn/matrix/api/v1/commerce/get_membership_info
Authorization: Bearer <桌面 App 的 mmoat_ OAuth 令牌>
Content-Type: application/json

{}
```

```json
"op_credit_summary": {
  "total_remaining_amount": "11459.454",      // 总剩余积分
  "purchased_remaining_amount": "0",           // 其中购买的
  "free_remaining_amount": "11459.454"         // 其中赠送的
}
```

插件读的就是 `op_credit_summary.total_remaining_amount`。**注意别取错字段**：同一个响应里的 `total_remains_credit` 与 `opcredit_balance` 是旧账，在已迁移到积分池的账号上恒为 `0`，取它们会显示「0 积分」。

顺带一提，这里有三个**单位不同**的「钱」，别混：

| 数值 | 含义 | 本插件是否显示 |
|---|---|---|
| `op_credit_summary.total_remaining_amount` | Code 积分余额 | ✅ 就是它 |
| `token_plan_credit.remaining_credits` | 已购积分池 | ❌ |
| `query_balance.available_amount` | 开放平台钱包（元） | ❌ |

### 积分会过期吗？会

积分不是一池子，而是**按笔发放的批次**，每批有自己的到期日。客户端每天发一批，每批在**发放日 + 30 个自然日**到期（按账户所在时区，当日 00:00 失效），于是形成一条逐日错开的 30 天阶梯：

```
GET https://agent.minimax.cn/minimax-cloud/api/v1/credit/details?page_number=1&page_size=100
→ details[] { granted_amount, remaining_amount, consumed_amount, granted_at_ms, expire_at_ms, credit_type }
```

实测本机 23 笔：09-20 发的在 10-20 到期、09-21 发的在 10-21 到期……另有一笔 08-25 发的在 2027-08-25 到期（一年期批次，`credit_type` 1=购买 / 2=签到）。**到期日一律读 `expire_at_ms`**，不写死天数——至少存在 30 天与 365 天两种制式。

插件据此在**插件页面**（设置 → 插件 → DSH Connect MiniMax Code）与输入框工具行的胶囊里给出：

- **7 天内到期**的剩余积分，以及最近一笔的到期日
- **30 天内到期**的剩余积分
- 接下来几笔**到期批次**的清单（日期 + 金额）
- 余额条与本机消耗（token 数、等效金额）

只统计**仍有余额**的批次：已发放但用光的批次到期时并没有东西可损失，把它算进去会让每个账号都看起来"快过期了"。积分的消耗近似先进先出，所以**"7 天内到期"的金额常常是 0**（快到期的那些基本都已被用完），因此界面同时给出**最早到期时间**，那才是真正有意义的信号。

> 过期不会把批次里的 `remaining_amount` 清零（实测会留下 -0.31 这样的负值残留），而是把过期批次**排除在余额之外**；所以总额以余额接口为准。
>
> 台账的 `remaining_amount` 合计与余额接口的 `total_remaining_amount` 在**静止期逐位相等**；两次采样之间看到的差异，是账户在这段时间里被真实消耗掉的量。

### 消耗怎么算

两路数据各管一件事：

- **真实积分消耗**：余额是个活值，两次读取的差值就是这段时间真正花掉的积分（客户端也会并发消耗，所以差值含其它客户端的开销）。
- **本机消耗**：每次请求的响应都自带 `usage`（`input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`），插件原样累计。折算金额时**只用这四个分量自己算**，不能用任何 `total_token` 汇总值——上游的两级汇总口径不同（差 1.94 倍，差额正是缓存读取部分）。单价取自 [MiniMax 官方价目表](https://platform.minimax.cn/docs/pricing/overview)：

  | 模型 | 输入 | 输出 | 缓存读取 |
  |---|---|---|---|
  | `MiniMax-M3.1-Flash` | 1.00 元/百万 tokens | 4.00 | 0.10 |
  | `MiniMax-M3`（≤512k 输入） | 2.10 | 8.40 | 0.42 |
  | `MiniMax-M3`（>512k 输入） | 4.20 | 16.80 | 0.84 |

  折算出的金额是**等效金额**，不是扣费：积分与金额之间 MiniMax 没有公开换算关系（套餐只公布了 1×/3×/12× 的相对倍数），所以插件不会把它说成「花了多少积分」。

  > 官方价目表没有单列**缓存写入**（`cache_creation_input_tokens`）的单价，因此插件只统计它的 token 数、**不折算金额**，以免给出一个没有公开依据的数字。

### 限额窗口（套餐的两个滚动窗口）

套餐用量按两个滚动窗口计量（当前套餐为 5 小时与 7 天），插件会显示各窗口的已用百分比与重置倒计时。

读取走**开放平台官方文档给出的接口**（M Plan 用量说明页「如何查看 M Plan 用量 → 方式三：使用 API 接口查询」）：

```
GET https://www.minimaxi.com/v1/token_plan/remains
Authorization: Bearer <API Key>
```

该接口要的是**开放平台的 API 密钥**，不是 OAuth 令牌。密钥由账户自己持有，取法与桌面 App 相同 —— 用 OAuth 令牌请求 `GET /backend/account/token_plan_credit?business=Agent&device_platform=desktop`，响应里的 `api_key` 就是它。

```json
"model_remains": [{
  "model_name": "general",
  "start_time": 1793882204091, "end_time": 1793900204091,   // 差值 = 5 小时
  "current_interval_used_percent": "19%",
  "weekly_start_time": 1793783898054, "weekly_end_time": 1794388698054,  // 差值 = 7 天
  "current_weekly_used_percent": "29%"
}]
```

几点实测结论：

- **窗口时长不写死**：从响应自身的起止字段推导（实测恰为 5 小时与 7 天），套餐条款变了显示会跟着变 —— 胶囊与详情行上的窗口名（`5h`、`7d`）也是这么来的，不是写死的字面量
- **无限量的窗口不报百分比**：上游用 `current_*_status` 标出没有额度的窗口（桌面 App 读作 `isUnlimited: 3 === status`），这类窗口不参与显示，避免出现「0%」这种没人能据此行动的读数
- **没有订阅就没有窗口，且这不算错误**：上游对未订阅 M Plan 的账户明确回 `2062 no active token plan subscription`，插件会如实标为「无订阅」而不是「读取失败」—— 积分包本身不带滚动窗口
- **接口异常时其余显示不受影响**：限额读不到，胶囊与卡片仍显示余额、签到与本机用量
- 上游还发 `current_*_count` 计数字段（无计数制时为 `-1`），插件只读百分比与起止时刻
### 账户用量画像

账户的**用量历史**由开放平台的用量汇总接口给出，与「本机累计 token」是两回事 —— 后者只统计这台机器发起的请求：

```
GET https://www.minimaxi.com/backend/account/token_plan/usage_summary?token_type=5&heatmap_days=365&business=Agent&device_platform=desktop
Authorization: Bearer <OAuth 令牌>
```

卡片显示的是其中有行动价值的几项：

| 字段 | 含义 |
| --- | --- |
| `current_consecutive_days` | 连续使用天数 |
| `active_days` / `total_days` | 统计窗口内有使用的天数 / 窗口长度 |
| `total_token_consumed` | 窗口内累计消耗（上游自己的写法，如 `826.14M`） |
| `usage_ranking_percent` | 用量排名分位 |
| `most_active_day` | 最活跃的一天及其消耗 |

这一节读到的数据**不需要订阅 M Plan**：该接口属于账户域，用 OAuth 令牌即可读取，与限额窗口（属于订阅）不同。

### 图像与视频生成（H3）

插件页多了一个「生成」面板，可以直接用 MiniMax 的 **H3 生图**与 **H3 视频生成**：

- 图片：`MiniMax-H3-Image`（另有 `MiniMax-H3-Image-Highspeed`），可选画幅与 1K / 2K / 4K 清晰度
- 视频：`MiniMax-H3`，可选 5–15 秒、768P / 2K 与画幅

两者走的都是**开放平台官方文档给出的接口**：

```
POST https://api.minimax.cn/v1/images/generations          # 文生图，同步返回
POST https://api.minimax.cn/v2/video_generation           # 创建视频任务，异步
GET  https://api.minimax.cn/v2/query/video_generation/{id}  # 轮询任务
```

**不需要用户配置任何密钥。** 生成接口要的是开放平台的 API 密钥（`sk-cp-…`），而这个密钥是**账户自己的**：插件用 OAuth 令牌问 `token_plan_credit`（它本来就在读这个接口拿积分），响应里的 `api_key` 就是它。实测（2026-11-10）：

| 请求 | 鉴权 | 结果 |
|---|---|---|
| `/v1/images/generations` + `sk-cp-` 密钥 | 200，8.5 秒出图 | 1184×880 JPEG，395 KB，6401 tokens |
| `/v1/images/generations` + OAuth 令牌 | 401 `1004 login fail` | 生成接口只认 API 密钥 |
| `/v2/video_generation` + `sk-cp-` 密钥 | 200，任务 90 秒后 `succeeded` | 5 秒 768P 成片，162745 tokens |

生成的图片会**存进 DSH 的附件库**（`ctx.attachments`），所以它留在 DSH 自己的存储里，而不只是这个浏览器标签页。

#### 与桌面 App 的两处不同（实测所限，如实说明）

1. **不能像普通模型那样出现在模型选择器里。** DSH 宿主的 `ctx.llm` 只有对话适配器这一个注册点（`registerAdapter`），没有图像 provider 的挂载处；模型描述符 `LlmModelInfo` 也没有「输出模态」字段，选择器无从区分图像模型。pi-ai 自己虽有图像生成 API（`ImagesProvider` / `generateImages`），但 DSH 从不构造 `ImagesModels`，插件自己 `new` 一个也没有人会读。这三点都是宿主层面的事，插件改不动。
2. **视频在 DSH 侧目前没有承载。** `pi-ai`、`dsh-llm`、`dsh-attachment`、`dsh-llm-pi-ai` 四个包里关于 video 的声明各为零处 —— 没有视频内容块、没有附件媒体类型、没有渲染。视频因此只能生成后在面板里播放与下载，不能像图片那样进对话。

图片进对话是可行的：宿主公开了 `ctx.attachments.admitPromptContent()`，插件可以独立完成「生成 → 落库 → 拿到持久引用」；但附件入口是浏览器 `File` 上传，**没有附件库**可供挑选，因此要进对话仍需作为下一轮 prompt 的一部分提交。这一步已由 0.6.1 完成（见下）。

### 关于续期

OAuth 令牌有效期约 1 小时，由客户端自动续期。插件**只在自己的令牌已过期时**才用 App 已存的 refresh token 续一次，并把轮换后的新令牌按客户端**原格式原子写回**同一个文件（`generation` 保持不变），因此桌面 App 的登录态不受影响。插件不会发起登录、不会登出、也不会调用任何付费/订阅类接口。

> 这一节的结论与 0.2.x 的「无法显示额度」相反。当时的调查按 `credits` / `quota` / `summary` 这类英文语义猜路径，真实接口用的是 `commerce` / `membership` 这套计费域词汇，因此全部落空；后来是从桌面 App 自己的运行日志（`%APPDATA%\MiniMax\logs\api-*.log`）里读出它每天真实调用的 URL，才定位到这条路径。

## 已知限制

- **仅支持国内版（`agent.minimax.cn`）**。国际版网关是否可用**未经验证**，请勿据此推断其他区域可用。
- **必须开启推理**。MiniMax 的全部模型都声明需要推理，关不掉。首字延迟因此高于非推理模型。
- **未登录时模型列表是内置兜底**。此时选择器中仍会显示 `M3`、`M3.1-Flash` 两个内置条目，但它们无法真正调用；登录后才会切换为上游实时目录。判断是否可用，请以实际调用结果为准。
- **积分只覆盖 MiniMax Code 的赠送/购买积分**，不包含开放平台钱包余额与已购积分池，插件也不会把金额折算成积分。
- **余额是账户级数值**，两次读取的差值包含 MiniMax Code 其它客户端的并发消耗；本机单独的消耗看胶囊里的 token 数与等效金额。
- **等效金额是按公开价目表折算的估值**，不是实际扣费；官方未公开 token 与积分的换算关系。
- **OAuth 令牌过期时积分胶囊会暂时失效**。复用桌面 App 登录态时，打开一次 MiniMax Code 让它自行续期即可；用插件自己登录的，插件会用自己的 refresh token 续期（服务端会轮转 refresh token，插件会把新的一对写回自己的文件）。这不影响模型对话。
- **签到需要账号能领**。签到是上游给账号的权益，插件只是替你按那个按钮；服务端判定「暂不可签到」时插件只会如实显示，不会重试或绕过。
- **自动签到默认关闭**，且只在服务端明确说「当天可领」时才发请求、每天至多一次。是否开启、以及这样做是否符合 MiniMax 的服务条款，请自行判断。
- **不提供设置界面卡片**。插件不在 DSH 设置页注册卡片；界面只在输入框工具行增加一枚胶囊（**仅选中本插件的模型时显示**），以及插件页面里的一张小卡片。
- **上游接口非公开**，MiniMax 客户端更新后可能失效。余额接口失效时胶囊会显示「积分不可用」，不会影响模型对话。
- **发图依赖宿主的附件服务**。模型目录声明了 `image` 模态（`M3`、`M3.1-Flash`），但把持久化附件读成请求字节是宿主的活儿：宿主没有附件服务时插件仍能加载并服务文本，只是带图的请求会被拒绝。
- **上下文窗口按网关的真实上限声明（1,000,000），不是目录里的 512,000**。上游 `limit.context` 是**默认档位与计费分界**（输入超过 512k 的部分按更高倍率计费），`context_window_options` 里最大的一档才是网关执行的硬上限。实测（2026-10-25）：946,206 tokens 正常受理，1,050,000 被拒（`invalid params, context window exceeds limit (2013)`）。此前按 512,000 声明，长会话一旦过线就**每一轮**都被判成「上下文溢出」，模型其实答得好好的，回复却被丢掉（`pi-ai detected context overflow`）。
- **设备码流需要能访问 `account.minimax.cn`**，且授权时要在浏览器里能登录 MiniMax 账号。某些内网或受限网络下打不开授权页。

## 更新记录

### 0.6.2（2026-11-11）

- **修复「无法发送到对话」**：上一版从插槽的 props 里找会话标识，但宿主是把会话交给**插槽的注入回调**的（该插槽是会话作用域的），于是标识始终为空，图片自然送不出去。现在按宿主的方式取会话标识。
- **多一条投递路径**：宿主若不提供直接发送的会话面，插件会退回到输入框自己的附件通道 —— 与手动拖一张图进输入框完全同路，图片出现在输入框里，由你按下发送。
- 图片到达本身就是反馈，成功后不再留提示条，输入框保持干净。
- `tests/generate-dock.spec.ts` 重写为**按宿主的真实投递方式**驱动插件（6 个用例）：会话标识来自注入回调、图片作为 `{type:"image", mediaType, data}` 随提示词发出、没有发送通道时退回输入框、以及两条路都没有时的提示。

### 0.6.1（2026-11-11）

- **生成的图片现在能直接进对话**：输入框工具行新增一个「生成图片」入口，写下提示词点生成，图片会作为**这一轮消息的一部分**发给模型 —— 走的是宿主自己那条路（`ctx.sessions.binding(id).session.prompt(content, mode, signal, requestId)`，与输入框按发送键完全相同），因此图片会被宿主校验、落成持久附件，并按普通消息参与对话。
- 宿主若不暴露会话句柄，该入口会明确提示「无法发送到对话」，而不是静默失败；插件页的生成面板仍可照常使用。
- 新增 `tests/generate-dock.spec.ts`（4 个用例）钉住：入口注册在工具行、声明了 `sessions` 服务、生成的图以 `{type:"image", mediaType, data}` 的形态（原始 base64，不带 data-url 前缀）随提示词一起发出、以及没有会话句柄时的提示。全量 252 个用例通过。

### 0.6.0（2026-11-11）

- **新增 H3 图像与视频生成**：插件页多了一个「生成」面板，可直接调用 MiniMax 的 `MiniMax-H3-Image`（文生图）与 `MiniMax-H3`（视频生成）。走的是开放平台官方文档给出的接口（`POST /v1/images/generations`、`POST /v2/video_generation` + 轮询 `/v2/query/video_generation/{id}`），**用户无需配置任何密钥** —— 生成接口要的是账户自己的开放平台密钥，插件用 OAuth 令牌问本来就在读的 `token_plan_credit` 就能拿到。
- **生成的图片存入 DSH 的附件库**（`ctx.attachments`），因此它留在 DSH 自己的存储里，而不只是浏览器标签页。
- 选项（画幅、清晰度、时长、分辨率）由服务端下发，取的是上游真正提供的那一组。
- **实测**（2026-11-10）：图片 8.5 秒出图，1184×880 JPEG / 395 KB / 6401 tokens；视频 5 秒 768P，任务 90 秒后 `succeeded`，162745 tokens。生成接口只认 API 密钥，OAuth 令牌会被拒（`1004 login fail`）—— 这条链路的每一步都有测试钉住（新增 `tests/generation.spec.ts`，12 个用例）。
- **如实说明与桌面 App 的差异**：H3 **不能像普通模型那样出现在模型选择器里**（宿主的 `ctx.llm` 只有对话适配器一个注册点，模型描述符也没有输出模态字段），**视频在 DSH 侧目前完全没有承载**（四个包里关于 video 的声明各为零处）。图片进对话是可行的，但附件入口只有浏览器上传、没有附件库，因此仍需作为下一轮 prompt 的一部分提交 —— 这一步的宿主接线留待下一版。

### 0.5.10（2026-11-10）

- **删除 `awesome-dsh-plugin-submission/` 目录**：收录已停止维护，目录里的草稿条目早已合入官方注册表、提交规则在上游 `contributing.md` 里也有完整说明，留着只会让人误以为还需要它。README 中对应的说明一并去掉（历史更新记录里提到该目录的地方保留文字、只去掉链接，不留死链）。

### 0.5.9（2026-11-10）

- **README**：移除指向已不存在仓库的引用（该仓库现已 404），灵感来源、同类插件与致谢三处一并清理，保留的做法与仍有效的同类项目说明不变；README 中保留的每一个仓库链接都已逐一确认存活。
- **README**：市场收录章节改为如实描述现状 —— 十二个收录 PR 均已关闭、为收录开的分叉已清理、那些目录不再维护，分发以 npm 与本仓库 Releases 为准；仍收录本插件的两个注册表（官方注册表与 dshbase）照旧列出。npm 包内含 README，因此本次改动需要发版才能在包页生效。

### 0.5.8（2026-11-10）

- **修复「M3 的推理关不掉」**：插件此前对**所有**推理模型都声明「不支持关闭推理」，理由是网关会以 `400 ... requires adaptive thinking` 拒绝 `thinking: {type: "disabled"}`。但该拒绝只对 `forced_on` 的模型成立 —— 上游模型目录逐模型声明 `thinking_config.mode`，`MiniMax-M3` 是 `switchable`（实测接受该形式，200），`MiniMax-M3.1-Flash` 才是 `forced_on`（实测 400）。现在按上游声明逐模型处理：**M3 的推理档位里出现了「关」**，选它就真的不发推理，既省 token 也更快；M3.1-Flash 的行为不变，选项仍不出现。
  上游的 `effort_options`（M3.1-Flash 有 default/low/medium/high/xhigh/max 六档）也一并解析存档，但**未接线**：pi-ai 的档位映射目前走 budget 形式，要用上这六档得切换整个请求形态，这一步不在本次改动里。
- **新增「账户用量画像」**：读取开放平台的 `GET /backend/account/token_plan/usage_summary`（该常量此前定义了却从未使用），卡片显示连续使用天数、统计窗口内的活跃天数、窗口内累计消耗、用量排名分位与最活跃的一天。它说的是**账户**的历史，与胶囊里「本机累计 token」是两回事。
- **说明「为什么没有限额窗口」**：账户未订阅 M Plan 时，上游回 `2062 no active token plan subscription`（0.5.7 已识别）。现在卡片直接写明「未订阅 M Plan（仅积分包），因此没有限额窗口」，而不是让人以为读取失败。
- **接口盘点**：把桌面 App 每天真实调用的 20 个账户域接口全部盘了一遍 —— 其中 **19 个用 OAuth 令牌即可读取，无需任何订阅**，只有「限额窗口」属于订阅本身。也就是说订阅 M Plan 换来的不是「更多接口」，而是**限额窗口**与**更高额度**这两样。
- 新增 `tests/usage-profile.spec.ts`（16 个用例）与 `tests/catalog.spec.ts` / `tests/adapter.spec.ts` 的推理模式用例。全量 236 个用例通过。

### 0.5.7（2026-11-10）

- **限额窗口改走官方文档接口**：原先读的是 `/backend/account/token_plan/remains_percent`，这条路径现在对任何账户都只回一个空的 `success`（连 `model_remains` 字段都没有），于是限额一栏对所有人都显示不出来，却看不出原因。改用开放平台官方文档（M Plan 用量说明页）给出的 `GET /v1/token_plan/remains`。新接口要求**开放平台 API 密钥**而非 OAuth 令牌，密钥取自 `token_plan_credit` 的响应并缓存复用。
- **「没有订阅」不再被报成「读取失败」**：上游对未订阅 M Plan 的账户明确回 `2062 no active token plan subscription` —— 积分包本身不带 5 小时 / 周滚动窗口。插件现在把这种情况标为「无订阅」，余额、签到与模型调用不受任何影响。
- 旧路径保留为**兜底**：账户若拿不到开放平台密钥，仍走旧路径，不会因此彻底没有限额显示。
- 顺带修正一处误伤可能：限额接口是拿开放平台密钥问的，它回 401 说明的是密钥不对，**不是本人凭据被吊销**；此前它参与「凭据是否被吊销」的判断，可能把人误登出。现在该判断只看账户域接口（会员信息与积分流水）的 401。
- 新增 `tests/quota-endpoint.spec.ts`（13 个用例）钉住：计划密钥的取法、官方接口用密钥而非 OAuth 令牌请求、`2062` 归为「无订阅」而非错误、无密钥时回落旧路径、密钥只取一次。全量 209 个用例通过。

### 0.5.6（2026-11-09）

- **修复「模型请求全部失败，但积分/签到正常」**：这是两条凭证路径读的不是同一个文件。模型网关此前只认插件自登录与桌面 App 留下的**旧版 JWT**（`local-runtime.auth.json`），而新版 App 早已改用 OAuth 存储（`auth/prod/<region>/mcode-public/auth.json`，`mmoat_` 令牌）。旧 JWT 过期后网关一律回 `401 auth failed`，而积分走的是 OAuth 文件，于是出现「积分能看、模型不通」。现在网关依次尝试：插件自登录 → **桌面 App 的 OAuth 授权** → 旧版 JWT，三者取第一个可用的。
- **修复「令牌被上游吊销后永不重登」**：吊销不会改动本地记录的过期时间，而此前的续期判断**只看过期时间**，于是死令牌被一直使用，所有请求 401，界面却仍显示已登录、也没有重新登录入口。现在账户接口返回 `401` 会触发一次强制续期；续期被拒（`400`/`401`/`invalid_grant`，或凭据本身没有 refresh token）则删除该凭据、清空缓存状态，卡片改为提示重新登录。**续期的网络错误与 `5xx` 不算吊销**，不会因为上游一时抽风就把人登出。
- **修复状态卡把「可用」报成「已过期」**：卡片的登录态此前只读旧 JWT，因此网关明明能通也显示 `expired`。现在它描述的是**网关实际会用的那枚凭据**，并新增 `credential-revoked` / `credential-expired` 两种更贴切的提示文案（指向卡片上的登录按钮，而不是「去桌面 App 登录后重启 DSH」）。
- 新增 `tests/revoked-credential.spec.ts`（6 个用例）钉住：401 后凭据被删除且卡片转为未登录、被拒时给出「重新登录」提示、`503` 不会误删凭据、无桌面 App 时插件自登录显示为已登录、OAuth 授权优先于旧 JWT、状态文档不泄露任何令牌。全量 193 个用例通过。

### 0.5.5（2026-11-07）

- **新增「限额窗口」显示**：读取开放平台的 `GET /backend/account/token_plan/remains_percent`（该接口来自桌面 App 每天真实调用的日志，同样未在官方文档中公开），展示套餐的**5 小时窗口**与**每周窗口**的已用百分比与重置倒计时。窗口时长从响应自身的起止字段推导，不写死 5 小时或 7 天——套餐条款变过不止一次，显示应跟随服务端所说。
- 该接口属于账户域，**只认 OAuth 令牌**（桌面 App 登录态或插件自登录均可）；JWT 打它返回 `1016 invalid api key`。读取挂在积分轮询上，独立容错：限额读不到不影响余额显示，反之亦然。
- 显示位置：胶囊详情与插件页卡片各两行；新增 `tests/rate-limit.spec.ts` 钉住解析、URL、容错与轮询接线。
- 窗口名跟随服务端：胶囊主标签与详情行上的窗口长度（`5h`、`7d`）从响应的起止字段推导，而不是写死 —— 解析层早已「不写死窗口长度」，显示层此前却写着「5h」，两处现在一致。
- 无限量窗口不报百分比：上游用 `current_*_status` 标出没有额度的窗口，这类窗口不参与显示，避免出现没人能据此行动的「0%」。
### 0.5.4（2026-10-29）

- **修复长会话被误判为「上下文溢出」**：上游 `limit.context`（512,000）是**默认档位与计费分界**，网关实际执行的上限是 `context_window_options` 里的 1,000,000。此前按 512,000 声明，会话一旦超过这条线，**每一轮**都会被判定为 `pi-ai detected context overflow` —— 而模型其实正常答了，回复却被丢弃。现在按网关的真实上限声明窗口。
- 兜底名录（离线时的内置猜测）同步改为 1,000,000。
- 新增 4 个用例钉住窗口解析：取 `context_window_options` 的最大值、上游没给就回落 `limit.context`、非法列表被忽略、兜底名录的窗口不是 512k。

### 0.5.3（2026-10-25）

- **修复图片输入**：此前发图必然失败 —— `本轮运行失败 pi-ai image input requires the durable attachment service`（`UNSUPPORTED_CONTENT`）。模型目录一直把 `image` 写进模型的输入模态，但插件构造 `PiAiAdapter` 时没有给 `resolveAttachments` 与 `resolveImageAccess` 两个钩子，pi-ai 因此无法把持久化的附件引用变成请求字节，在发往网关之前就拒绝了调用。现在插件按需读取宿主的 `attachments` 服务，并用 `fs.processPathFromHostPath` 把附件的宿主路径映射进当前执行世界；宿主没有提供附件服务时这两个钩子为 `undefined`，纯文本调用不受影响。
- 新增 `tests/image-input.spec.ts`，钉住两个钩子的解析、路径映射，以及「宿主没有附件服务仍能加载」；`peerDependencies` 增加 `@deepseek-ai/dsh-attachment`。
- 实测：真实网关 + `M3.1-Flash` 发一张 2×2 PNG，回答正确（`inputTokens: 316`）。

### 0.5.2（2026-10-21）

- **插件页图标**：新增随包发布的 `icon.svg`（48×48，800 字节内），并在 `package.json` 里声明 `"icon": "./icon.svg"`。宿主会把它读成 data URL 画在插件页卡片上，不再是默认占位图。
- **插件页标题与简介的中英文**：新增 `locale/en.json` 与 `locale/zh.json`（宿主按包根 `locale/` 目录里的语言文件读取，英文文件是基准）。此前插件页显示的是包名 `dsh-connect-minimaxcode` 和 package.json 里那句中英混排的描述；现在标题是 `DSH Connect MiniMax Code`，简介按宿主语言给中/英两版。
- **界面文案跟随宿主语言**：此前两个插槽都拿不到翻译函数（composer 与 plugin-page 插槽的 standardProps 里没有 `t`），所以界面永远走内置中文兜底，英文界面下也是中文。现在改为 `locale.bind()` 之后经插槽的 `inject` 传进去，英文界面显示英文。
- `exports` 增加 `./locale/*`（宿主要通过它解析语言包），`files` 增加 `locale` 与 `icon.svg`。

### 0.5.1（2026-10-20）

- **余额读数跟随所选模型**：从输入框下方的 dock 移到**输入框工具行（模型选择器旁）**，并按宿主 `modelSelection` 投影门控 —— **只有选中 `minimaxcode` 模型时才显示**；切到其他反代插件（如 dsh-connect-workbuddy）的模型即整体隐藏，且不轮询（学习 `dsh-connect-trae` 的做法）。
- **`engines.dsh` 收窄为 `>=0.2.1-rc.2 <0.3.0-0`**：只声明实测过的档位，此前的 `>=0.1.7-rc.1` 覆盖过宽。

### 0.5.0（2026-10-20）

- **新增「自己登录」**：插件可以自己走 OAuth 设备码流登录 MiniMax Code，**不再依赖本机已安装并登录的桌面 App**。你在自己的浏览器里确认，插件不接触密码；凭据存在插件自己的文件里，不写客户端的目录。
- **新增「每日签到」**：读取上游的七天一签进度（400/400/400/1000/400/400/1000 = 4000 分/轮），显示当天状态与到期批次，并提供手动「签到」与**默认关闭**的「每天自动签到」。
- **实测更正**：`mmoat_` 令牌**既能调模型网关也能调账户接口**（此前文档写「OAuth 打网关会 401」，是错的）—— 所以一次登录即可覆盖模型、积分与签到。
- 插件自建的两条路由：状态路由之外新增一条 POST 动作路由（签到、登录、开关设置），**仅限 loopback**。

### 0.4.2（2026-10-19）

- **可发现性**：npm 描述改为中英双语，关键词补齐（`dsh`、`credits`、`usage` 等）；GitHub 仓库描述与 topics 同步更新。
- 仓库内新增 `awesome-dsh-plugin-submission/`：市场收录条目草稿与提交规范。
- 新增[英文版 README](README.en.md)。

### 0.4.1（2026-10-19）

- **修正台账翻页参数**：接口会**接受** `page` 然后**忽略**它，真正生效的是 `page_number`。批次超过 100 笔的账号原本会反复收集同一页。
- **更正到期规则表述**：「发放后 29 天」是拿 UTC 发放时刻对 UTC 到期时刻的混算假象，真实规则是**发放日 + 30 个自然日**（按账户时区当日 00:00 失效）。另存在 365 天制式批次，所以到期日一律读接口的 `expire_at_ms`。
- 更正两处表述：过期**不清零**批次的 `remaining_amount`（可能有负值残留），而是把过期批次**排除在余额之外**；台账合计与余额在静止期逐位相等，采样间隔里的差额是期间真实消耗。

### 0.4.0（2026-10-19）

- **新增「积分即将过期」**：积分是按笔发放、每批独立到期的（发放日 + 30 个自然日）。插件读取积分台账 `GET /minimax-cloud/api/v1/credit/details`，在**插件页面**与胶囊里显示 7 天内到期、30 天内到期、最近到期日与到期批次清单。
- **只统计仍有余额的批次**，避免把「已用光但快到期」的批次算成损失。
- **插件页面卡片**：在「设置 → 插件 → DSH Connect MiniMax Code」新增一张卡片（余额、赠送/购买拆分、到期分布、到期批次、本机消耗与等效金额），列表里则显示一行摘要。
- 胶囊与卡片共用一个状态存储与同一个轮询器，多个界面不会重复请求账户接口。

### 0.3.0（2026-10-19）

- **新增积分余额显示**：对话框输入框下方的胶囊显示 MiniMax Code 的剩余积分（赠送/购买拆分），点开可看两次读取之间的消耗、本机累计 token 与按官方价目表折算的等效金额。
- **新增用量计量**：每次请求的 `usage` 取自上游响应本身，累计到本机并折算金额。
- **新增账户接口定位**：找到桌面 App 每天真实调用的 `POST /matrix/api/v1/commerce/get_membership_info`，并**推翻了 0.2.x 「无法显示额度」的结论**——原因见「积分余额与用量」末尾。
- **令牌策略调整**：模型网关用 JWT、账户接口用桌面 App 的 OAuth 令牌；后者过期时插件会用 App 已存的 refresh token 续期，并按客户端原格式写回，不影响桌面 App 登录态。
- **首次带浏览器侧插件**：新增 `lib/client.js`（classic script），只注册一枚 composer dock 胶囊。**升级后需重启一次 DSH**。

### 0.2.3（2026-10-19）

- **同步上游模型变动**：MiniMax 下架了 `M2.7`、`M2.7-highspeed` 两个旧模型；此前以匿名形式灰度的测试模型（代号 "space bunny" / 太空兔）正式发布为 **`M3.1-Flash`**。当前上游实时目录为 `M3`、`M3.1-Flash`。
- 内置兜底列表与文档随之更新。**已登录用户无需更新插件**即可看到模型变动（列表来自上游实时目录），本次发布只是让未登录兜底、测试与文档与上游保持一致。

历史版本见 [GitHub Releases](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/releases) 与 [npm 版本列表](https://www.npmjs.com/package/dsh-connect-minimaxcode?activeTab=versions)。

## 市场收录与展示

插件已包含可安装的 `dsh.bundle` manifest，并发布到 npm —— **安装方式以 npm 为准**：

```bash
dsh plugin --profile desktop add dsh-connect-minimaxcode
```

社区插件市场（`dshmarket`）的目录由 [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 注册表生成，本插件的条目已在该注册表中（[#8110](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8110) 收录、[#8380](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8380) 更新），因此也会出现在 DSH 的插件中心里。

**其它目录**：此前也向若干 awesome 清单提交过收录条目，但那些项目的更新活跃度很低，条目与为此开的分叉都已清理完毕，**不再维护**。插件的分发以 npm 与本仓库的 Releases 为准。

| 渠道 | 状态 |
|---|---|
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（官方注册表，`dshmarket` 目录来源） | ✅ 已收录 |
| [dshbase](https://github.com/ylwl1997/dshbase) | ✅ 已收录（自动扫描） |
| 其它 awesome 清单 | 已停止维护，条目与分叉已清理 |

市场截图按当前约定由**插件自己仓库根目录的** `screenshots.json` 声明（注册表 `data/screenshots.json` 是旧约定下的回退，不再新增键）。本仓库目前**尚未提供截图**，所以还没有这个文件；补上截图后，在根目录放 `screenshots.json`（内容是图片相对路径的数组）即可被市场卡片取用。

> **0.5.1 起，读数移到输入框工具行（模型选择器旁）并按宿主 `modelSelection` 投影做门控**：余额属于「下一次请求真正会用的那个 provider」，所以它既该待在选模型的地方，也该在选中别的反代插件（如 workbuddy）时**整体隐藏、且不发轮询请求**——这是学习 `dsh-connect-trae` 的做法（其 `ComposerPointsGate` 对非自家 provider 一律 `return null`）。
>
> 工具行是共享插槽，理论上可能被其它插件挤掉（同族 `workbuddy` issue #62 就丢过一次读数，trae 的解法是双座位）。**本插件目前只注册工具行一个座位**；若真被挤掉，dock 常驻行是已验证的备选方案。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-connect-minimaxcode
```

## 开发

```bash
pnpm install
pnpm test        # 单元测试 + 宿主集成测试
pnpm typecheck   # 类型检查
pnpm build       # 构建
```

构建依赖 `@earendil-works/pi-ai`，需与宿主中 `dsh-llm-pi-ai` 解析出的版本一致（当前为 `0.85.x`），否则类型不兼容。

界面半边（`src/client.ts`）由 `tsconfig.client.json` 单独编译成 **classic script**（`lib/client.js`）：宿主以 `<script>` 方式加载客户端 bundle，若产出 ESM 会直接导致 Web 启动失败（`Cannot use import statement outside a module`），所以这里刻意不用打包器、也不自带 React——React 来自宿主的浏览器模块表。

**`lib/` 是纳入版本管理的构建产物**，不是生成物。这是刻意为之：git 源安装拿到的是仓库原样内容，若不含 `lib/`，pnpm 会判定该包"需要构建"并触发 `prepare`，随即被构建脚本白名单拦下。改动源码后请重新构建并提交：

```bash
pnpm build && git add lib
```

## 同类插件

这些插件与本插件的思路一致——**复用你本机桌面 App 已有的登录态，把模型接进 DSH**，无需另配 API Key。它们由不同作者独立开发，与本项目无隶属关系。

| 插件 | 数据来源 | 每日签到领免费额度 | 额度 / 用量显示 |
|---|---|---|---|
| **dsh-connect-trae** | Trae（国内版 + 国际版） | ✅ 国内版 | ✅ Work / 通用积分概览 |
| **dsh-qoder-connect** | Qoder（国内版 + 国际版，PAT） | ✅ 每日 100 Credits | ✅ 侧栏额度小卡 + 明细 |

> 各插件的签到规则、额度口径与限制以各自文档为准。下表为同一台机器上的实测读数，仅代表当时状态，非承诺。

### [dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae)

把本机已登录的 Trae 接入 DSH，国内版与国际版可同时使用。国内版支持每日签到领积分，并提供 Work / 通用积分的只读概览。注意 Trae 的签到按「每台设备每天一次」限制。

```bash
dsh plugin --profile desktop add dsh-connect-trae
```

### [dsh-qoder-connect](https://github.com/masknull/dsh-qoder-connect)

以个人访问令牌（PAT）接入 Qoder，双区域独立配置。每日自动签到领取 100 Credits 算力额度，签到时刻可自定义（默认 10:00，UTC+8），并带开机防漏补签；另有侧栏额度展示与逐包明细。

```bash
dsh plugin --profile desktop add dsh-qoder-connect
```

## 贡献者

- **[eghrhegpe](https://github.com/eghrhegpe)** —— 提出了插件页图标与中英文文案的建议（[#1](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/issues/1)）。这条建议促成了 0.5.2：插件页有了自己的 SVG 图标，标题与简介有了中英两版，界面文案也开始跟随宿主语言。
- **[azsora](https://github.com/azsora)** —— 从桌面 App 的实际调用里找出了套餐的**限额窗口接口**，并把 5 小时与每周两个窗口的用量接进了积分胶囊与插件页卡片（[#4](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/pull/4)）：窗口时长从响应自身的起止字段推导，不写死。该功能成为 0.5.5。
- **[qzz19970504](https://github.com/qzz19970504)** —— 定位并修复了「发图必然失败」的接线缺口（[#3](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/pull/3)）：模型目录声明了 `image` 模态，但适配器没有把宿主的持久化附件服务接上，导致带图请求被 pi-ai 在发出前拒掉。该修复成为 0.5.3。
- 插件作者：**[JeffTsuiCUG](https://github.com/JeffTsuiCUG)**

## 致谢

- **[dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)** — 同方向的另一实现，本插件的**插件结构与 provider 注册组织方式**参考了它。
- [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) — 同作者的 DSH 插件，可作为 DSH 插件结构的参照。

> 上方「同类插件」中的项目均为独立开发者的作品，与本项目无隶属或背书关系，各自遵循其自身的许可与免责声明。

## 许可证

[MIT](./LICENSE)