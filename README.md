# accurLex 法律工具 for DeepSeek Harness

`@accurlex/dsh-legal` 为 DeepSeek Harness 提供法律问答、法规检索、文书起草、合同审查和用量查询。它是原生 DSH bundle，通过工具直接调用 accurLex REST API。

**0.2.0 起支持在 Harness 对话中完成短信开通。** 用户提供手机号，收到短信后输入验证码，插件自动注册或认证账户、取得当前功能的 API Key 并保存在本机，随后继续原任务。用户无需打开控制台、选择 scope 或手动复制 Key。验证码始终发到用户手机，插件不能代收。

## 安装或更新

在已经安装 DSH CLI 的环境，将 bundle 安装到实际使用的 profile，然后重启该 profile：

```powershell
dsh plugin --profile web add @accurlex/dsh-legal@0.2.0
dsh web
```

使用 headless 时，将 web 换成 headless。各 profile 的安装相互独立；demo 仅用于注册和配置检查，不作为完整 Agent 的运行环境。桌面版的安装入口以宿主版本为准。

源码：[MrPunchLeonardo/accurlex-dsh-legal](https://github.com/MrPunchLeonardo/accurlex-dsh-legal)。本包遵循 `dsh.bundle.patch` 格式，安装时不执行构建或注册脚本，插件加载阶段不联网、不发送短信、不读取凭证。参考 [DSH 官方打包与安装说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)。

## 第一次使用

安装后直接向 Harness 描述任务，例如：“请使用 accurLex 审查这份合同，我是乙方。”缺少当前功能的凭证时，插件引导 Agent 执行以下流程：

1. 调用 accurlex_connect 的 status，确定所需功能及是否已有本机凭证。
2. 说明手机号用途、当前功能权限、凭证保存和费用，展示[用户协议](https://accurlex.com/user_agreement.html)、[隐私政策](https://accurlex.com/privacy_policy.html)、[价格与限额](https://accurlex.com/open-platform/pricing.html)，取得用户同意。
3. 用户提供可接收短信的中国大陆手机号，Agent 调用 start，服务端向该手机发送验证码。
4. 用户在当前对话中提供手机收到的4位验证码。Agent 使用同一次开通的 capability、connection_id 和验证码调用 complete。
5. 插件私下保存 Key，返回 ready，Agent 继续原任务。工具回复不输出完整 Key、手机号或验证码，也无须额外调用收费能力来验证新 Key。

已有账户复用原账户，新用户由服务端创建账户。原有密码、余额和网页登录不受这个接入方式影响。插件不自动充值、不批量开通其他权限、不因免费额度不足自行升级专家模式。限免、额度和价格以服务端当前规则为准，不能宣称永久免费。

手机号和验证码由用户在 Harness 对话中提供，因此宿主及所选模型可能处理这些输入；插件不新增输入日志，但不能承诺宿主的聊天或执行记录不保存它们。不要把号码、验证码或 Key 放进仓库、示例文件或命令行参数。

## 适合 accurLex 的使用方法

accurLex 与通常接收短查询的语义检索不同，支持较长输入，并会自动解析事实、材料和任务目标。**在字符上限内，尽量一次传入完整的相关材料**，包括背景、条款、用户立场和要求，无须先抽成关键词或省略事实。需要补充证据或定点检索某个问题时，再组织有针对性的查询。

| 能力 | 输入上限 |
| --- | --- |
| 法律问答 deep／expert | 问题与背景合计 10,000／30,000 字符 |
| 法规检索 deep／expert | 完整检索材料 10,000／30,000 字符 |
| 合同审查 | 合同与立场合计 30,000 字符 |
| 文书起草 | 写作要求、用户参考材料及样本文书合计 30,000 字符 |

历史对话另外受 20,000 字符限制。超过上限会报错，不会静默截断，也不自动拆成多次收费调用。插件只发送本次参数，不自动读取或上传整个工作区。

文书正文、normal 模式的合同审查意见书应完整呈现。服务检索返回的法条依据与用户提供的 reference_material 是两种数据：前者用于核验，后者是输入材料。工具保留 original_content 等结构化结果，Agent 可以按需展示或在用户要求时保存依据，不必将全部法条重复贴进聊天。插件本身不自动落盘保存业务材料和结果。

## 工具与权限

| 工具 | 参数与用途 | 自动开通权限 |
| --- | --- | --- |
| accurlex_connect | action 为 status／start／complete，capability 指定本次功能 | 仅当前功能 |
| accurlex_legal_qa | question、context_text、mode、history | qa_deep 或 qa_expert |
| accurlex_law_search | prompt、mode；已有 query 别名继续可用 | law_search |
| accurlex_contract_review | contract_text、standpoint、output_mode、history | contract_review |
| accurlex_document_draft | prompt、reference_material、sample_document、history；已有 requirement 别名继续可用 | document_draft |
| accurlex_account_usage | 可选 capability，默认 qa_deep | 不新增权限 |

law_search 覆盖两种检索模式，授权该 scope 不表示专家模式永久免费。用量工具查询选中 Key 的记录，不代表汇总全部 Key；保留汇总并仅展示最近5条明细，返回 recent_total、recent_limit、recent_truncated。

### 对话开通参数

status 只检查凭证存在及格式，不联网验证其有效性：

```json
{"action":"status","capability":"contract_review"}
```

start 传 phone 和用户已经同意后的 consent: true，返回 sms_sent、connection_id 及有效期。complete 传相同 capability、该 connection_id 和用户提供的 code。不要混入其他 action 的字段，不在示例中填写真实号码、验证码或 Key。

replace: true 仅用于用户明确要求更换当前功能的本机凭证，不撤销服务端旧 Key。restart: true 仅在用户要求重新发码、距上次至少60秒时使用。断线恢复应继续原流程，不盲目重发短信。

### 已有 API Key

已有 Key 的用户可继续在启动 Harness 的进程中配置：

```powershell
$env:ACCURLEX_API_KEY = 'ak_live_***'
```

显式环境变量始终优先；格式错误或权限不足时不会偷偷切换账户。修改环境变量需重启宿主。显式 Key 存在时插件不执行短信替换，否则新 Key 会被原配置遮蔽，应由用户先决定修改或移除显式配置。

也可以到[开放平台](https://accurlex.com/open-platform.html)登录，在[控制台](https://accurlex.com/open-platform/console.html#api-keys)手动管理权限与撤销 Key。此方式是可选入口。

## 本机存储与恢复

自动开通复用已上线的 /index.php/SkillHub/start 与 complete，路由名称不限制平台；自动 Key 在控制台可能显示已有 SkillHub 来源标签。凭证位于当前系统用户的 `~/.accurlex/skillhub/<scope>.env`，可与现有 SkillHub、WorkBuddy 客户端复用，不污染工作目录。开通后业务立即读取，无须重启 Harness。

Windows 使用当前用户 SID 设置私有 ACL；其他系统使用目录0700、文件0600。保存失败即停止，不退回到在聊天中显示 Key。同一系统账号下的其他进程仍可能读取凭证；多人共用或远程 Harness 服务应隔离不同用户的系统身份和用户目录，不能共享本机凭证目录。

| 情况 | 处理 |
| --- | --- |
| 请求断连、结果不明 | 使用同一手机号、功能及原流程重试相应 action；保留的 client secret 让服务端恢复同一次操作。插件不自动重试 |
| 验证码错误 | 请用户核对后再输入，不猜测或枚举 |
| 验证码过期、旧流程被替代 | 经用户同意后重新发码；验证码有效5分钟，流程恢复窗口10分钟 |
| 另一个开通正在执行 | 返回 request_in_progress，不覆盖状态或删除活跃锁 |
| 已有10个启用 Key | 用户到控制台停用不用的 Key 后继续，不自动撤销其他 Key |
| 账号停用、Key 撤销或权限不足 | 处理原账号或权限，不切换身份或绕过限制 |

短期状态在同目录 .pending-<scope>.json，包含手机号及恢复秘密，成功后删除。.lock-<scope> 用于互斥；崩溃遗留锁需人工核对 PID 已退出后才能清理。不同 connection_id 不能混用验证码。业务超时或断线不能套用短信恢复流程自动再发一次收费任务。

## 配置与输出

默认请求 https://accurlex.com。ACCURLEX_API_BASE_URL 可用于用户明确配置的测试服务或代理，但仅显式配置的 Key 才随此覆盖发送；自动 Key 只发往 accurlex.com。短信服务地址固定，不接受模型输入 URL。认证和业务请求均禁止跟随 HTTP 重定向。

toolCallTimeoutMs 默认600000（10分钟），映射 DSH 原生 timeoutMs，取值为1到2147483647的整数；需要宿主挂载 timeout-policy 才会执行工具超时策略。请求遵守 exec.signal，短信另有25秒请求上限。

```yaml
- insert:
    - id: accurlex-dsh-legal
      name: '@accurlex/dsh-legal'
      config:
        toolCallTimeoutMs: 600000
```

业务接口使用 stream: true，插件完整接收 JSON／NDJSON、忽略 heartbeat 并聚合结果，最终返回一次，不在聊天中逐 token 输出。original_content 保留在结构化结果中。

合同审查默认 output_mode: normal；已有 json 模式仍可显式调用并解析结果。插件不实现原文定位、Word 修订或自动替换，Agent 不应声称已经修改用户文件。起草和检索优先用 canonical prompt，已有别名保持原行为。

## 开发验证

```powershell
npm ci --ignore-scripts
npm test
npm pack --dry-run
```

自动化测试使用合成手机号、验证码、材料及临时用户目录，不调用真实短信或收费上游。覆盖原 API 行为、缺 Key 引导、五项权限开通、私密存储、失败恢复、取消和账户选择。真实手机验收、真实模型对话及 npm 发布状态以发布记录为准，mock 通过不等同于真实联调通过。

本地 checkout 可通过 `dsh plugin --profile demo add <本仓库路径>` 安装，再用 `dsh --profile demo --dump-config` 检查 bundle。实际 Agent 测试使用独立 web／headless profile，避免改变已有配置。

src/onboarding-client.cjs 复用2026-10-19已发布的短信客户端，在 DSH 中增加取消信号及显式 challenge 绑定；文件随包分发，不依赖旁边存在平台仓库，不要求 Agent 执行额外脚本。服务端固定映射权限，客户端不接受任意 scope 申请。

## 许可证

本插件及仓库按 MIT License 发布，LICENSE 随包分发；不改变 accurLex 平台、开放平台 API、服务端或前端的许可证。
