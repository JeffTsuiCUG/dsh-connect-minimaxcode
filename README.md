# DSH Connect MiniMax Code (`dsh-connect-minimaxcode`)

把本机已登录的 **MiniMax Code 桌面 App** 的模型接入 **DeepSeek Harness（DSH）**，装好即用，无需配置 API Key。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![dsh](https://img.shields.io/badge/DSH-0.2.0%20%7C%200.1.7--0.3.0-0-cordis-8957e5.svg)

---

## ⚠️ 重要声明（请先阅读）

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

## 前置条件

1. 已安装并**登录** MiniMax Code 桌面 App
2. DSH 桌面版（内置内核 `0.2.0` 系列）或 Web profile

## 安装

桌面版（profile 由 Electron 应用独占，需使用 App 自带的载体 CLI）：

```powershell
& 'D:\dsh\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add dsh-connect-minimaxcode
```

Web profile：

```bash
dsh plugin --profile web add dsh-connect-minimaxcode
```

安装后**无需重启**，插件会热加载；模型随后出现在模型选择器的 **MiniMax Code** 分组中。

## 使用

1. 打开 DSH 的模型选择器，选择 `MiniMax Code` 分组下的模型（如 `M2.7`、`M3`）
2. 正常对话即可，工具调用由 DSH 本地工具执行

### 令牌有效期提示

MiniMax Code 的登录令牌为短期 JWT（通常约 15 天）。本插件**不会自动续期**，设置卡片会提示状态：

| 状态 | 含义 | 处理方式 |
|---|---|---|
| 🟢 已登录 | 令牌有效 | 正常使用 |
| 🟡 即将过期（剩余 < 24 小时） | 令牌即将失效 | 打开一次 MiniMax Code 即可刷新 |
| 🔴 已过期 | 令牌已失效 | 在 MiniMax Code 中重新登录，然后重启 DSH |

> 令牌过期不会丢失数据，打开 MiniMax Code 桌面 App 重新登录后其会自动写入新的令牌。

## 工作原理

1. 读取 `~/.minimax/local-runtime.auth.json`（MiniMax Code 写入的明文登录信息），**仅在内存中**解析其 JWT
2. 调用 `GET /mavis/api/v1/models` 获取实时模型目录（含上下文长度、多模态、工具调用等能力声明）
3. 注册 `minimaxcode` provider，指向 `POST /mavis/api/v1/llm/v1/messages`（标准 Anthropic Messages 协议）

插件**不**包含任何硬编码的 Token、账号或接口密钥。

## 当前状态与限制

- **仅支持国内版（`agent.minimax.cn`）**。国际版的可用性未经验证。
- **不提供余额/用量显示**。相关接口需要另一套服务端鉴权，非用户 Token 可访问。
- **不自动续期令牌**，请参照上方「令牌有效期提示」。

## 卸载

```powershell
& 'D:\dsh\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove dsh-connect-minimaxcode
```

## 开发

```bash
pnpm install
pnpm test        # 单元测试
pnpm typecheck   # 类型检查
pnpm build       # 构建
```

## 致谢

- [dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) — DSH 插件结构与 provider 注册的参照
- [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) — 本机登录态复用的设计参照

## 许可证

[MIT](./LICENSE)