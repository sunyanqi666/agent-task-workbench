# API 契约（v1）

领域数据契约以 `packages/contracts/src/index.ts` 为单一事实来源，本文为阅读版摘要。修改契约后需同步两者。

## 通用约定

- 统一前缀 `/api/v1`，请求 / 响应均为 JSON（SSE 除外）。
- 错误响应统一为 `{ "error": { "code": string, "message": string, "requestId": string } }`。
- 所有输入在服务端校验：无效输入返回 400，无余额返回 402，超限（并发 / 频率）返回 429，找不到返回 404，状态冲突返回 409，非预期错误返回 500（不泄露密钥或堆栈）。
- 时间一律 ISO 8601 字符串。
- 开发模式下前端通过 Vite 代理访问 `/api/v1`（5173 → 3000），避免硬编码跨域地址。

## 端点

| 方法 | 路径 | 说明 | 实现阶段 |
| --- | --- | --- | --- |
| GET | `/api/v1/health` | 服务状态、版本；不暴露配置或密钥 | P0 ✅ |
| GET | `/api/v1/models` | 服务端受控模型目录 + 各模型单任务预估费用上限 | P4 ✅ |
| POST | `/api/v1/tasks` | 创建任务（可选 `modelId`），返回 201 与任务对象；live 未配置返回 503 | P1 ✅ |
| GET | `/api/v1/tasks?limit=&offset=` | 按创建时间倒序分页查询（limit 1..100，默认 20） | P1 ✅ |
| GET | `/api/v1/tasks/:id` | 获取任务快照 | P1 ✅ |
| GET | `/api/v1/tasks/:id/events?afterSeq=n` | 获取持久化事件以供回放（默认 afterSeq=0） | P1 ✅ |
| GET | `/api/v1/tasks/:id/stream` | SSE 推送新事件；事件 ID 使用 `seq`，支持从上次序号续接 | P2 ✅ |
| GET | `/api/v1/tasks/:id/ledger` | 该任务的扣费明细（账本条目，按时间升序；demo 为空列表） | P5 ✅ |
| POST | `/api/v1/tasks/:id/cancel` | 请求取消；终态重复操作保持幂等 | P3 ✅ |
| POST | `/api/v1/tasks/:id/retry` | 创建新任务并关联原任务（`parentTaskId`，沿用原任务模型） | P3 ✅ |
| POST | `/api/v1/auth/register` | 注册并登录（HttpOnly Cookie 会话） | P5 ✅ |
| POST | `/api/v1/auth/login` | 登录 | P5 ✅ |
| POST | `/api/v1/auth/logout` | 登出（204） | P5 ✅ |
| GET | `/api/v1/auth/me` | 当前登录用户；未登录返回 `{ user: null }` | P5 ✅ |
| GET | `/api/v1/me/balance` | 余额与进行中任务预留合计；未登录 401 | P5 ✅ |
| POST | `/api/v1/payments/mock-topup` | 模拟充值回调（登录后）；按 `paymentId` 幂等 | P5 ✅ |
| POST | `/api/v1/payments/refund` | 退款（登录后）；累计不超原充值，重放幂等 | P5 ✅ |

### 示例（P1/P2 已实现端点）

```bash
# 创建任务（demo 模式）：POST 后异步执行
curl -X POST http://localhost:3000/api/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt": "计算 (12+8)*3 的结果"}'
# → 201 {"id": "…", "status": "queued", "mode": "demo", …}

# 查看终态与事件回放
curl http://localhost:3000/api/v1/tasks/<id>
curl "http://localhost:3000/api/v1/tasks/<id>/events?afterSeq=0"

# 实时订阅（SSE，-N 关闭缓冲）
curl -N "http://localhost:3000/api/v1/tasks/<id>/stream?afterSeq=0"

# 取消（queued/已取消 → 200；running → 202 受理，终态经事件流推送）
curl -X POST "http://localhost:3000/api/v1/tasks/<id>/cancel"

# 重试失败/已取消任务 → 201 新任务（parentTaskId 关联原任务）
curl -X POST "http://localhost:3000/api/v1/tasks/<id>/retry"
```

### 示例（P5 账号 / 账本 / 支付）

```bash
# 注册（成功即登录，后续请求携带 HttpOnly Cookie）
curl -c jar.txt -X POST http://localhost:3000/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"username": "alice", "password": "password123"}'

# 模拟充值回调（paymentId 幂等，重复回调 recorded=false）
curl -b jar.txt -X POST http://localhost:3000/api/v1/payments/mock-topup \
  -H 'content-type: application/json' \
  -d '{"paymentId": "ch_001", "amountCny": 10.5}'
# → 200 {"recorded": true, "balanceCny": 10.5}

# 创建 live 任务：按预估上限预留（余额不足 402）
curl -b jar.txt -X POST http://localhost:3000/api/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt": "计算 7*6 的结果", "mode": "live", "modelId": "deepseek-flash"}'

# 余额 / 扣费明细
curl -b jar.txt http://localhost:3000/api/v1/me/balance
curl -b jar.txt http://localhost:3000/api/v1/tasks/<id>/ledger
# → {"entries": [{"kind": "reserve|actual|settle|topup|refund", "amountCny": -0.48, …}]}

# 退款（累计不超原充值，重放幂等）
curl -b jar.txt -X POST http://localhost:3000/api/v1/payments/refund \
  -H 'content-type: application/json' \
  -d '{"paymentId": "ch_001", "amountCny": 4}'
```

创建后事件序列（demo 表达式任务）：
`task.created → task.started → model.output → tool.started → tool.completed → model.output → task.completed`

### SSE 流（`GET /api/v1/tasks/:id/stream`）

- **帧格式**：每条事件两行——`id: <seq>` + `data: <TaskEvent JSON>`，事件间空行分隔；不使用 `event:` 字段，客户端 `onmessage` 统一处理；每 15 秒发送 `: ping` 注释行作心跳，代理场景带 `x-accel-buffering: no` 防缓冲。
- **续接语义**：`afterSeq`（默认 0）之后的事件先从数据库**回放**，再实时推送新事件，因此连接建立瞬间不会丢事件也不会乱序。
- **关闭语义**：任务进入终态（`task.completed` / `task.failed` / `task.canceled`）推送后服务端关闭流；连接已终态任务时直接回放完关闭。
- **客户端幂等**：浏览器 `EventSource` 断线自动重连（URL 固定 `afterSeq` 会重发已收事件），前端按 `seq` 去重合并即可；这也是刷新后恢复现场的方式——先 `GET /events` 全量回放，再从最后 `seq` 续接订阅。

### 任务控制（cancel / retry，P3）

`POST /api/v1/tasks/:id/cancel`：

- `queued`：直接落 `canceled`，返回 200 与终态快照；
- `running`：经进程内注册表向运行器发**协作式取消信号**，返回 **202**（已受理），终态由运行器写入并经事件流推送；
- `canceled`：幂等返回 200 当前快照；`completed` / `failed`：409。
- 取消生效点：运行器步间检查、模型 HTTP 调用（取消信号透传给适配器）、工具执行（与超时信号合并，任一触发即中止）；生效后 `task.canceled` 是最后一个事件，之后不再写入过程事件。
- 进程重启遗留的 running 孤儿任务：注册表无记录时取消直接落终态，不依赖内存状态。

`POST /api/v1/tasks/:id/retry`：

- 仅 `failed` / `canceled` 任务可重试，其他状态 409；
- 创建**新任务**（同 prompt / 同 mode，`parentTaskId` 指向原任务）并异步执行，原任务历史不改写；返回 201 与新任务快照；重复重试会各自生成独立新任务，关联关系明确。

### live 模式（真实模型，P3）

- 环境变量：`MODEL_PROVIDER=deepseek` 与 `MODEL_API_KEY` 必填；`MODEL_BASE_URL`（默认 `https://api.deepseek.com`）、`MODEL_NAME`（默认 `deepseek-flash`，仅作未选模型时的回退）可选。密钥仅服务端读取，不进入事件与日志。
- 未配置时创建或重试 live 任务返回 503（`live_model_not_configured`），不返回假成功。
- 适配器走 OpenAI 兼容 chat completions：每次步进重建消息序列（system + prompt + 历史输出 / 工具调用与结果），携带白名单工具声明；模型返回工具调用则继续循环，返回纯文本即视为最终总结（finish）。
- 每次模型调用与工具执行共用 `STEP_TIMEOUT_MS` 步超时预算，且可被取消信号中止。

### 模型选择与用量（P4）

- **受控目录**：`GET /api/v1/models` 返回服务端允许的模型（当前为 `deepseek-flash` / `deepseek-v4-pro`；旧名 `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 被供应商停用，提交将返回 400，历史任务经迁移 003 映射到现行名称）。前端只能提交目录中的 `modelId`，非法值返回 400；缺省为 `deepseek-flash`。
- **固化选择**：创建任务时 `modelId` 写入任务行（`tasks.model_id`），重试生成的新任务沿用原任务选择；live 适配器按任务所选模型发起请求（未指定回退全局 `MODEL_NAME`）。
- **用量记录**：live 模型每次响应中供应商返回的 `usage`（`prompt_tokens` / `completion_tokens`）累加到任务行（`tasks.prompt_tokens` / `tasks.completion_tokens`），任务快照以 `usage: { promptTokens, completionTokens }` 返回；demo 任务恒为 0。用量是任务行事实而非过程事件，不进入事件流。
- **推理模式**：两个模型均默认开启思考模式，响应含 `reasoning_content`（思维链）。带工具调用的轮次，适配器会把思维链在后续所有请求中随 assistant 消息传回（DeepSeek 要求，缺失返回 400）；无工具调用的轮次不传回（API 会忽略）。
- **多工具调用**：一次响应可返回多个 `tool_calls`，运行器逐个执行（每个调用产生 `tool.started` + `tool.completed`/`tool.failed` 事件对），结果按序回传——assistant 消息声明全部调用，每个调用对应一条 `tool` 结果消息（id 确定性生成并成对）；任一调用参数非法则整轮失败，避免部分执行。
- 账号、额度与费用控制（P5）建立在这条链路之上，见下节。

### 账号、额度与用量账本（P5）

**账号归属**：任务归属于创建者（登录用户）；未登录只能创建 demo 任务，live 任务要求登录（未登录 401）。所有权校验覆盖快照 / 事件 / 流 / 取消 / 重试 / 扣费明细：匿名访问用户任务与访问不存在的任务同样返回 404（不泄露存在性）。

**额度与限额（创建 / 重试时的路由层校验）**：

- 余额校验：live 预估费用上限超过当前余额 → 402 `insufficient_balance`；
- 单任务预算：预估上限超过 `MAX_TASK_BUDGET_CNY`（默认 10 元）→ 400；
- 并发与频控：进行中任务数超 `MAX_USER_CONCURRENT_TASKS`、创建频率超 `USER_CREATE_RATE_PER_MINUTE` → 429；
- 限额对 demo 模式不生效（不计费）。

**用量账本（`ledger_entries`，唯一读写入口 `ledgerService`）**：

| 类型 | 方向 | 语义 | biz_key（幂等键） |
| --- | --- | --- | --- |
| `reserve` | −R | 创建 / 重试 live 任务时扣预留（R = 预估费用上限） | `reserve:{taskId}` |
| `actual` | −A | 每次模型响应按真实 usage 扣费；用量缺失（解析失败等）按每步估算兜底归集 | `actual:{taskId}:{step}` |
| `settle` | +R | 任务终态释放全部预留（状态机事务内触发，重启恢复同样覆盖） | `settle:{taskId}` |
| `topup` | +X | 充值入账（仅服务端验证后的回调） | `topup:{paymentId}` |
| `refund` | −X | 退款出账 | `refund:{paymentId}:{amount}` |

- 净扣恒等于 Σactual（预留只是占用，结算原路释放），不存在重复扣费路径；每条记录固化 `price_version`（如 `2026-09-26.1`）与 `balance_after` 余额快照，目录调价时递增 `MODEL_PRICE_VERSION`。
- 余额口径：`topup + refund + settle + actual` 的累计和（`GET /api/v1/me/balance`），进行中任务的预留单独返回 `reservedCny`。
- 任务详情页展示扣费明细（`GET /api/v1/tasks/:id/ledger`）；价格版本随任务快照返回（`priceVersion`）。

**支付测试环境（mock）**：

- `POST /api/v1/payments/mock-topup`：模拟「服务端验证后的支付成功回调」，`paymentId` 幂等——重复回调返回 `{ recorded: false }` 不重复入账；金额必须为正数（分精度，四舍五入到分）、单笔 ≤ 10000 元，非法金额 400 不入账（失败路径演练）。
- `POST /api/v1/payments/refund`：必须引用本用户的一笔充值（否则 404）；分笔退款累计不得超过原充值（400 `refund_exceeds_topup`）；同一通知重放（同 `paymentId` 同金额）幂等跳过。
- 真实支付接入时，把 mock 回调替换为带签名验证的服务端对服务端回调即可，入账语义（biz_key 幂等）不变。

**运营保护**：工具白名单与 `MAX_STEPS` / `MAX_TOOL_CALLS_PER_TURN` / `STEP_TIMEOUT_MS`（P1-P3）+ 单任务预算与用户限额（P5）+ 平台日预算告警 `PLATFORM_DAILY_BUDGET_CNY`（默认 50 元；当日 reserve+actual 净流出超阈值仅告警不阻断）+ 对账测试（预留/扣费/释放/充值/退款在测试中逐笔核对）。前端创建 live 任务时展示预估费用上限、当前余额与「模型供应商将处理任务内容」提示。

### 启动恢复（P4）

运行器循环与取消注册表都在进程内存中，进程中断后数据库可能遗留进行中状态的任务。服务启动时（注册路由前）识别并处理，保证任何任务都不会永久悬停：

- `queued`（中断前尚未开始执行）：自动重新入队执行，事件与状态照常持久化；
- `running`（中断前执行循环已随进程丢失）：落终态 `failed`，错误码 `interrupted`，可经重试生成新任务。

处理数量输出到启动日志；恢复对已终态任务无影响。

## 任务状态机

```
queued ──▶ running ──▶ completed
   │           │
   │           ├──▶ failed
   └───────────┴──▶ canceled
```

- 终态（`completed` / `failed` / `canceled`）不可迁移。
- 任务状态更新与对应事件追加在同一事务中完成（P1 由任务服务保证）。
- 合法迁移表见 `TASK_STATUS_TRANSITIONS`。

## 事件类型

`task.created`、`task.started`、`model.output`（流式文本片段）、`tool.started`、`tool.completed`、`tool.failed`、`task.completed`、`task.failed`、`task.canceled`。

事件是唯一的过程记录载体：实时流（SSE）与历史回放共用同一结构，全部持久化到 SQLite 的 `task_events` 表；载荷按类型校验，不持久化 API 密钥。

## 工具契约

每个工具声明：`name`、`description`、`inputSchema`（简化 JSON Schema）、`execute(input, context)`；上下文含任务 ID 与取消信号。参数校验拒绝未声明参数；默认工具集不包含任意命令、任意文件或任意外部网址访问。

已注册工具（P1，均为纯计算、无外部访问）：

| 工具 | 输入 | 说明 |
| --- | --- | --- |
| `calculate` | `{ expression: string }` | 算术求值（+ - * / %、括号、小数）；手写递归下降解析器，不用 eval |
| `text_stats` | `{ text: string }` | 统计字符数、词数、行数 |

运行器只允许调用注册表内工具（白名单）；单步执行受 `STEP_TIMEOUT_MS` 超时约束，任务总步数受 `MAX_STEPS` 上限约束（只计模型轮次），一轮内执行的工具调用数受 `MAX_TOOL_CALLS_PER_TURN` 上限约束（超限调用不执行，记为失败结果回传，模型可容错），超出即失败（`timeout` / `max_steps_exceeded`）。
