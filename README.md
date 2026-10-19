# DSH Connect MiniMax Code (`dsh-connect-minimaxcode`)

把本机已登录的 **MiniMax Code 桌面 App（国内版）** 的模型接入 **DeepSeek Harness（DSH）**，装好即用，无需配置 API Key。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![version](https://img.shields.io/badge/version-0.2.3-cornflowerblue.svg)
[![npm](https://img.shields.io/npm/v/dsh-connect-minimaxcode?color=cb3837)](https://www.npmjs.com/package/dsh-connect-minimaxcode)
[![CI](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/actions/workflows/ci.yml/badge.svg)](https://github.com/JeffTsuiCUG/dsh-connect-minimaxcode/actions/workflows/ci.yml)

## 灵感来源

本插件的思路来自 **[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)**（作者 Corrine Hu）。

它最早证明了这样一件事：**桌面 App 已经登录的模型，可以零配置地搬进 DSH**——不去碰账号密码，不引入新的鉴权体系，只是把本机已有的登录态接上一个 provider，并复用 DSH 自带的 provider 适配器。本插件把同一套做法用在了 MiniMax Code 上：

| | dsh-workbuddy-connect | 本插件 |
|---|---|---|
| 数据来源 | WorkBuddy 桌面 App 的本地登录态 | MiniMax Code 桌面 App 的本地登录态 |
| 接入方式 | 注册 DSH provider，暴露已登录模型 | 同左 |
| 目录来源 | 上游实时模型列表 | 同左 |

同方向的另一实现是 **[dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)**，本插件在**插件结构与 provider 注册的组织方式**上参考了同一作者的 [dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae)（该项目的连接内核本身也参照了 corrinehu 的实现，见其 README 致谢）。

> 两者的价值可以这样区分：**corrinehu 是最早的开创者**，「复用本机登录态」的路线由它确立；**dingminhua 的实现更贴近 DSH 插件结构的既有约定**，本插件的目录布局与 `cordis.patch.yml` 写法沿用了后者。二者都已列入文末致谢。

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
- **积分余额可见**：在对话框底部的胶囊里显示 MiniMax Code 的剩余积分，以及本机累计消耗
- **实时消耗统计**：每次请求的 token 用量取自上游响应本身，可按官方价目表折算等效金额
- **复用官方适配器**：上游为标准 Anthropic Messages 协议，直接复用 DSH 自带 provider，工具调用、推理块、上下文压缩均由 DSH 托管
- **只读为主**：除「续期已过期的桌面 App 登录态」外，不写入、不修改 MiniMax 的任何文件，也不执行任何登录动作
- **界面不打扰**：胶囊只在输入框下方的 dock 里占一行，不改动 DSH 的其它界面

## 前置条件

1. 已安装并**登录 MiniMax Code 桌面 App（国内版）**
2. DSH 桌面版（内置内核 `0.2.0` 系列）或 Web profile

## 安装

**方式一：从 Git 仓库安装**（推荐，拿到最新代码）

```bash
dsh plugin --profile desktop add github:JeffTsuiCUG/dsh-connect-minimaxcode
```

**方式二：npm 安装**（发布后可用）

```bash
dsh plugin --profile desktop add dsh-connect-minimaxcode
```

Web profile 把 `--profile desktop` 换成 `--profile web`。

> 桌面版的 profile 由 Electron 应用独占，若 `dsh` 命令不在 PATH 中，请使用 DSH 应用自带的载体 CLI（路径随安装位置而变，例如 `<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd`）。

安装后**无需重启**，插件会热加载；模型随后出现在模型选择器的 **MiniMax Code** 分组中。

> 界面胶囊（积分余额）属于浏览器侧插件，**首次安装或升级到 0.3.0 后需要重启一次 DSH** 才会出现在输入框下方。

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

## 积分余额与用量

对话框输入框下方的胶囊会显示 MiniMax Code 的**剩余积分**；点开还能看到赠送/购买拆分、两次读取之间的消耗，以及本机累计的 token 与等效金额。

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
- **OAuth 令牌过期时积分胶囊会暂时失效**，需打开一次 MiniMax Code 桌面 App 让它自行续期（或等待插件续期成功）。这不影响模型对话。
- **不提供设置界面卡片**。插件不在 DSH 设置页注册卡片；界面只增加输入框下方的一枚胶囊。
- **上游接口非公开**，MiniMax 客户端更新后可能失效。余额接口失效时胶囊会显示「积分不可用」，不会影响模型对话。

## 更新记录

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
| **dsh-workbuddy-connect** | WorkBuddy（国内版 + 国际版） | — | ✅ 剩余积分 + 明细 |

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

### [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)

接入 WorkBuddy 桌面 App，国内版与国际版可并存，各自使用自己的账号与积分。提供账号信息、令牌有效期与剩余积分查看，并带 CLI：

```bash
dsh plugin --profile web exec dsh-workbuddy-connect status
```

> 该插件的版本需与你的 DSH 内核严格对应（不同内核线用不同版本），安装前请见其 README 的版本对应表。

## 致谢

- **[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)** — **本插件的灵感来源**。「复用桌面 App 本机登录态、把已登录模型接进 DSH」的整体思路由该项目最早确立，本插件沿用同一做法；凭据只读复用的设计也参照于此。
- **[dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)** — 同方向的另一实现，本插件的**插件结构与 provider 注册组织方式**参考了它（其连接内核亦参照 corrinehu 的实现，见该项目致谢）。
- [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) — 同作者的 DSH 插件，可作为 DSH 插件结构的参照。

> 上方「同类插件」中的项目均为独立开发者的作品，与本项目无隶属或背书关系，各自遵循其自身的许可与免责声明。

## 许可证

[MIT](./LICENSE)