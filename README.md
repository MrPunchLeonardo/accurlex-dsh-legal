# `@accurlex/dsh-legal`

DeepSeek Harness 的 accurLex 法律工具 bundle。它直接调用 accurLex Open Platform REST API，不修改 accurLex 服务端，也不依赖旧版 MCP/stdio/JWT 接入。

## 快速开始

这是一个已发布到 npm 的 DSH bundle。实际使用请安装到 `web` 或 `headless` profile：

```powershell
$env:ACCURLEX_API_KEY = 'ak_live_***'
dsh plugin --profile web add @accurlex/dsh-legal
dsh web
```

只验证注册和配置合并时使用 `demo` profile：

```powershell
dsh plugin --profile demo add @accurlex/dsh-legal
dsh --profile demo --dump-config
```

插件仓库：[MrPunchLeonardo/accurlex-dsh-legal](https://github.com/MrPunchLeonardo/accurlex-dsh-legal)。`demo` 只用于注册检查；实际 Agent 使用请按目标 profile 安装 bundle。首次使用前，请先阅读下方的账号注册和 API Key 配置说明。

## 插件许可证

`@accurlex/dsh-legal` 这个 npm 插件包及本仓库按 MIT License 发布，许可证文件会随 bundle 分发。本声明只适用于本 DSH 插件，不代表 accurLex 平台、开放平台 API、服务端或前端采用 MIT。

## 注册账号与获取真实 API Key

插件调用的是 accurLex 开放平台真实 API，需要先注册/登录 accurLex 账号并创建 API Key：

1. 打开 [accurLex 开放平台](https://accurlex.com/open-platform.html)，注册或登录账号。
2. 进入[开发者控制台](https://accurlex.com/open-platform/console.html#api-keys)，在 API Key 分区创建 Key。
3. 按实际使用的工具授予 scope：法律问答使用 `qa_deep` 或 `qa_expert`，法规检索的 `deep/expert` 两档均使用 `law_search`，合同审查使用 `contract_review`，已开启的文书起草使用 `document_draft`；用量查询只要求 Key 有效并启用。建议遵循最小权限原则。
4. 创建成功后立即复制完整 Key。完整 Key 只在创建时显示一次；不要把真实 Key 写入仓库、README、日志、前端代码、URL 或提交记录。
5. 在启动 DSH 的同一个 PowerShell 进程中配置 Key，然后再启动 DSH：

```powershell
$env:ACCURLEX_API_KEY = 'ak_live_***'
# 按下文安装到 web 或 headless profile 后再启动对应 profile
```

首次可先调用 `accurlex_account_usage` 检查 Key、scope 和用量，再调用其他工具。合同审查和文书起草可能消耗账户配额或点数，具体以[价格与限制](https://accurlex.com/open-platform/pricing.html)为准；需要撤销或重建 Key 时回到[开发者控制台](https://accurlex.com/open-platform/console.html#api-keys)操作。

注册、登录、Key 创建/撤销规则以[开放平台 API 文档](https://accurlex.com/open-platform/docs.html)和控制台为准；本 README 只提供 DSH 接入所需的最短路径。

## 配置 API Key

在启动 DSH 的进程环境中设置 API Key：

```powershell
$env:ACCURLEX_API_KEY = 'ak_live_***'
```

可选地覆盖 API origin（本地 mock 或隔离代理）：

```powershell
$env:ACCURLEX_API_BASE_URL = 'https://accurlex.com'
```

正常使用时不需要设置 `ACCURLEX_API_BASE_URL`，默认会直连 `https://accurlex.com`；只有本地测试或明确使用代理时才覆盖它。修改环境变量后需要重启 DSH，使新进程能够读取配置。

## 工具调用超时

插件配置项 `toolCallTimeoutMs` 默认是 `600000` 毫秒（10 分钟），适合合同审查等较重任务。它会映射到 DSH 原生工具定义的 `timeoutMs`，不是传给模型的业务参数；插件仍会把 DSH 的 `exec.signal` 传给底层请求。

可以在 bundle/profile 的 plugin 行中覆盖，例如：

```yaml
- insert:
    - id: accurlex-dsh-legal
      name: '@accurlex/dsh-legal'
      config:
        toolCallTimeoutMs: 900000
```

配置必须是 `1` 到 `2147483647` 之间的整数。实际超时执行依赖 DSH profile 挂载官方 timeout-policy；当前 DSH base profile 通常已包含该 policy。插件本身只声明工具超时元数据并配合取消信号，不新增运行时依赖。

插件加载和工具注册阶段不会联网；未配置 Key 也不会让 DSH 启动失败，真正调用工具时会返回 `configuration_error`。不要把真实 Key 写入仓库、日志、URL 或对话示例。

## 长响应与流式接收

法律问答、法规检索、合同审查和文书起草请求都使用 `stream: true`。开放平台发送的 heartbeat 用于保持长响应连接，插件会完整接收 JSON/NDJSON、忽略 heartbeat、合并 `data` 和 `original_content`，最后只向 DSH 返回一次聚合结果；不会在 DSH 中展示实时 token。合同审查和文书起草继续使用默认 10 分钟工具超时，不因开启流式请求自动延长。

## 安装与 profile 使用

本包遵循 DSH bundle manifest：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入 `@accurlex/dsh-legal` plugin。DSH 官方支持两种安装场景：发布后按 npm 包名安装，开发/验收时按本地 checkout 安装。两种场景不能混用。

`demo` profile 只适合验证插件注册和配置合并；它是裸 profile，直接启动 Agent 任务可能没有 web/headless 所需的运行时层，不能作为实际使用示例。

### 发布后安装（面向最终用户）

当 `@accurlex/dsh-legal` 已发布到 npm 后，最终用户不需要知道源码仓库位置，直接按包名安装：

先安装到 `demo` 并只做注册检查：

```powershell
dsh plugin --profile demo add @accurlex/dsh-legal
dsh --profile demo --dump-config
```

实际 Agent 使用请按目标 profile 单独安装 bundle。Web profile：

```powershell
dsh plugin --profile web add @accurlex/dsh-legal
dsh web
```

Headless profile：

```powershell
dsh plugin --profile headless add @accurlex/dsh-legal
dsh --profile headless "请调用 accurlex_account_usage 检查当前 Key"
```

安装或更新 bundle 后需要重启对应 profile；`demo`、`web`、`headless` 相互独立，安装到 demo 不会自动安装到另外两个 profile。

### 本地 checkout 安装（面向开发/验收）

本地验证时直接使用本插件仓库 checkout，不要把某台机器的绝对路径写入文档：

```powershell
$repoRoot = (git rev-parse --show-toplevel).Trim()
$pluginDir = $repoRoot

dsh plugin --profile demo add $pluginDir
dsh --profile demo --dump-config
```

需要验证实际 Agent 时，将同一个 `$pluginDir` 安装到 `web` 或 `headless` profile。该命令要求当前 PowerShell 位于仓库 checkout 内；用户也可以把 `$pluginDir` 替换为自己机器上的 checkout 路径。DSH 官方将相对路径/本地 checkout 视为开发安装方式，发布包则使用上面的 npm 包名。

本仓库包含 bundle、源码和本地契约测试；真实 profile 安装和生产部署仍需由使用者按目标环境执行。DSH 仍是 Developer Preview，具体 CLI 参数以当前版本官方文档为准。

### 许可证范围

`@accurlex/dsh-legal` 这个 npm 插件包按 MIT License 发布，`LICENSE` 会随 bundle 分发。该许可证只适用于本插件包，不改变 accurLex 平台、开放平台 API、服务端或前端的许可证口径。

## 工具

| 工具 | 作用 | 关键参数 |
|------|------|----------|
| `accurlex_legal_qa` | 法律问答 | `question`、可选 `context_text`、`mode`、`history` |
| `accurlex_law_search` | 法规/法条检索（deep/expert 均已开启） | `prompt` 或兼容 `query`（至少一个）、可选 `mode` |
| `accurlex_contract_review` | 合同审查 | `contract_text`、`standpoint`、可选 `output_mode`、`history` |
| `accurlex_document_draft` | 已开启的文书起草 | `prompt` 或兼容 `requirement`（至少一个）、可选 `reference_material`、`sample_document`、`history` |
| `accurlex_account_usage` | 当前 Key 用量查询 | 无业务参数 |

### API 能力对齐

- `accurlex_law_search` 对齐 `POST /v1/law_search`：`prompt` 是 canonical 输入，`query` 继续作为兼容 alias；`mode` 支持 `deep`（默认，最多 10,000 字符）和已开启的 `expert`（最多 30,000 字符），两档都使用 `law_search` scope。
- `accurlex_document_draft` 对齐已开启的 `POST /v1/documents_draft`：`prompt` 是 canonical 写作要求，`requirement` 继续作为兼容 alias；使用 `document_draft` scope，总输入最多 30,000 字符。插件请求 `stream: true`，但最终聚合后再返回 DSH。
- 当 canonical `prompt` 与兼容 alias 同时提供时，canonical 非空值优先；这两个工具的 API 能力由服务端负责认证、计费、额度和限流，插件不修改服务端开关。
- 为兼容 DSH Code Mode，这两个工具的 `prompt`/alias 字段在 schema 中保持可选；实际执行时仍要求至少提供一个非空值。

### 合同审查输出

合同审查默认使用 `output_mode: "normal"`，返回适合对话阅读的自然语言审查意见：

```json
{
  "contract_text": "……",
  "standpoint": "乙方，重点检查付款和违约责任"
}
```

需要程序化处理时显式选择 JSON：

```json
{
  "contract_text": "……",
  "standpoint": "乙方",
  "output_mode": "json"
}
```

插件会以 `stream: true` 调用并兼容合同接口的 NDJSON 响应：接收 heartbeat，合并 `data` chunks，保留 `original_content`，最后一次性返回聚合结果；JSON 模式会尝试解析最终结果，normal 模式不会被强制转成 JSON。

### 用量返回

`accurlex_account_usage` 保留 `summary`，但默认只在 `result`、`recent` 和可读 `content` 中返回最近 5 条 `recent` 记录，避免长 `request_id` 列表淹没对话。返回同时包含 `recent_total`、`recent_limit` 和 `recent_truncated`，便于调用方判断是否发生截断；不改变服务端原始数据。

## 上下文和数据边界

本插件允许 Agent 在本次参数中提供完整的相关合同、多个材料或项目背景，不因为隐私理由把内容强制压缩成片段；accurLex API 按现有平台策略不保存信息。插件不会在后台遍历、读取或上传整个 workspace，也不会自动补齐未提供的文件。上下文仍受开放平台当前字符上限约束，超过上限会报错而不会静默截断。

插件不保存 API Key、请求正文、合同内容、响应正文、工作区路径或索引，不自动重试、不排队、不缓存。错误只返回状态、错误码和脱敏消息。

## 开发验证

在本仓库根目录执行：

```powershell
node --test test/*.test.js
```

测试只访问 localhost mock server，使用合成材料；真实 API、真实 Key、真实合同和付费上游调用次数均为 0。

参考：[DeepSeek Harness 官方插件发布文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)。
