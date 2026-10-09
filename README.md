# DSH Connect MiniMax Code (`dsh-connect-minimaxcode`)

把本机已登录的 **MiniMax Code 桌面 App（国内版）** 的模型接入 **DeepSeek Harness（DSH）**，装好即用，无需配置 API Key。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![version](https://img.shields.io/badge/version-0.2.1-cornflowerblue.svg)

## 灵感来源

本插件的思路直接来自 **[dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)**（作者 dingminhua）。

它证明了这样一件事：**桌面 App 已经登录的模型，可以零配置地搬进 DSH**——不去碰账号密码，不引入新的鉴权体系，只是把本机已有的登录态接上一个 provider。本插件把同一套做法用在了 MiniMax Code 上：

| | dsh-connect-workbuddy | 本插件 |
|---|---|---|
| 数据来源 | WorkBuddy 桌面 App 的本地登录态 | MiniMax Code 桌面 App 的本地登录态 |
| 接入方式 | 注册 DSH provider，暴露已登录模型 | 同左 |
| 目录来源 | 上游实时模型列表 | 同左 |

该项目的架构（插件结构、provider 注册、只读复用登录态）也是本插件的主要参照，致谢见文末。

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
- **复用官方适配器**：上游为标准 Anthropic Messages 协议，直接复用 DSH 自带 provider，工具调用、推理块、上下文压缩均由 DSH 托管
- **只读**：插件不写入、不修改 MiniMax 的任何文件，也不执行任何登录或续期动作
- **不含客户端 UI**：不注册浏览器侧插件，因此不会影响 DSH 的启动（见「已知限制」）

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
   打开 DSH 的模型选择器，在 **MiniMax Code** 分组下选择模型。可用模型来自上游实时目录，例如 `M2.7`、`M2.7-highspeed`、`M3`、`M3.1-Flash-Preview`。

4. **正常对话**
   直接使用即可。工具调用由 DSH 本地工具执行，插件只负责提供模型通路。

5. **令牌过期时重新登录**
   MiniMax Code 的登录令牌为短期 JWT（通常约 15 天），本插件**不会自动续期**。过期后：

   | 现象 | 含义 | 处理方式 |
   |---|---|---|
   | 正常使用 | 令牌有效 | — |
   | 剩余不足 24 小时 | 令牌即将失效 | 打开一次 MiniMax Code 桌面 App 刷新 |
   | 请求返回鉴权错误 | 令牌已失效 | 在 MiniMax Code 中**重新登录**，然后重启 DSH |

   > 令牌过期不会丢失数据。在 MiniMax Code 桌面 App 重新登录后，它会自动写入新的令牌，插件下次启动即可读到。

### 关于响应速度

MiniMax 的这些模型**强制要求先推理再输出**，思考无法关闭。因此：

- 首个字符出现前会有一段等待（实测 M3.1-Flash-Preview 约 3 秒）
- 推理过程会以 `thinking` 块实时返回，可以在界面中看到模型"在想什么"
- 这是模型本身的行为，**不是插件造成的延迟**

若更看重流式体感的即时反馈，建议同时保留 DSH 官方模型或其他 provider 作为备选。

## 工作原理

1. 读取 `~/.minimax/local-runtime.auth.json`（MiniMax Code 写入的明文登录信息），**仅在内存中**解析其 JWT
2. 调用 `GET /mavis/api/v1/models` 获取实时模型目录（含上下文长度、多模态、工具调用等能力声明）
3. 注册 `minimaxcode` provider，指向 `POST /mavis/api/v1/llm/v1/messages`（标准 Anthropic Messages 协议）

### 与网关对接时的三个兼容处理

这些是实测中必须处理的差异，也是本插件与"直接改个 URL 就能用"的主要差异所在：

| # | 现象 | 处理 |
|---|---|---|
| 1 | 网关只认 `Authorization: Bearer`，而 pi-ai 默认发 `x-api-key`，后者单独出现会返回 `401 token is required` | 在模型描述符上附带 `Authorization` 头（网关同时接受两个头） |
| 2 | Anthropic SDK 会自己在 `baseUrl` 后追加 `/v1/messages`；若 `baseUrl` 已以 `/v1` 结尾，请求路径会变成 `/v1/v1/messages`，网关返回 `503 direct_route_not_configured` | `baseUrl` 收到版本段之前，由 SDK 补齐 |
| 3 | 所有模型强制要求推理，而"关闭推理"会让 pi-ai 发出 `thinking: {type: "disabled"}`，网关返回 `400 ... requires adaptive thinking` | 将"关闭"级别标记为不支持，使该字段被省略（网关接受） |

插件**不**包含任何硬编码的 Token、账号或接口密钥。

## 为什么没有额度显示

「显示剩余额度」这个功能被实测排除过，结论写在这里以免后来者重复调查。

**额度数据是真实存在的**。逆向 MiniMax Code 客户端可确认它使用了这样一组字段：

```
op_credit_summary: {
  total_remaining_amount,      // 总剩余额度
  purchased_remaining_amount,  // 购买额度剩余
  free_remaining_amount        // 免费额度剩余
}
```

**但找不到为它服务的接口**。已验证的部分：

| 尝试 | 结果 |
|---|---|
| `GET /v1/api/user/info` + 模型网关令牌 | `401`，两类凭证互不通用 |
| `GET /v1/api/user/info` + 客户端 OAuth 令牌（`mmoat_`） | `200`，但响应只有昵称、头像、`vipInfo` 等账户资料，**不含任何额度字段** |
| 14 个候选额度路径（`user/credits`、`user/quota`、`workspace/list`、`credit/summary` 等） | 全部 `404` |
| `account.minimax.cn` 同一批路径 | 同样无额度字段 |

上述额度字段只出现在客户端**已混淆的前端 bundle** 中，属于渲染逻辑；真正提供数据的接口路径未能定位。实测所用的 OAuth 凭证有效期约 1 小时，由客户端自动续期，不适合作为插件的长期依赖。

因此本插件不显示额度。若你已知可用路径，欢迎提Issue 或 PR；额度请直接在 MiniMax Code 客户端中查看。

## 已知限制

- **仅支持国内版（`agent.minimax.cn`）**。国际版网关是否可用**未经验证**，请勿据此推断其他区域可用。
- **必须开启推理**。MiniMax 的全部模型都声明需要推理，关不掉。首字延迟因此高于非推理模型。
- **未登录时模型列表是内置兜底**。此时选择器中仍会显示 `M2.7`、`M3` 两个内置条目，但它们无法真正调用；登录后才会切换为上游实时目录。判断是否可用，请以实际调用结果为准。
- **不提供余额/用量显示**。这一项经过实测后确认无法实现，原因记录在下方「为什么没有额度显示」中。
- **不自动续期令牌**，请参照上方「令牌有效期」。
- **不提供设置界面卡片**。本插件为纯宿主侧插件，不在 DSH 设置页注册任何卡片，因此不会参与浏览器端的启动流程（这同时也是它不会导致 DSH 启动失败的原因）。
- **上游接口非公开**，MiniMax 客户端更新后可能失效。

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

> 各插件的签到规则、额度口径与限制以各自文档为准。本表只列出经其 README 明确写出的功能，未逐项实测。

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

- **[dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)** — 本插件的灵感来源，架构与"复用本机登录态接入 DSH"的整体思路均源自该项目
- [dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) — 同作者的 DSH 插件，可作为 DSH 插件结构的参照
- [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) — 客户端 bundle 规范与凭据复用的设计参照

> 上方「同类插件」中的项目均为独立开发者的作品，与本项目无隶属或背书关系，各自遵循其自身的许可与免责声明。

## 许可证

[MIT](./LICENSE)