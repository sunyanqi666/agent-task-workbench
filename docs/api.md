# API 契约（v1）

领域数据契约以 `packages/contracts/src/index.ts` 为单一事实来源，本文为阅读版摘要。修改契约后需同步两者。

## 通用约定

- 统一前缀 `/api/v1`，请求 / 响应均为 JSON（SSE 除外）。
- 错误响应统一为 `{ "error": { "code": string, "message": string, "requestId": string } }`。
- 所有输入在服务端校验：无效输入返回 400，找不到返回 404，状态冲突返回 409，非预期错误返回 500（不泄露密钥或堆栈）。
- 时间一律 ISO 8601 字符串。
- 开发模式下前端通过 Vite 代理访问 `/api/v1`（5173 → 3000），避免硬编码跨域地址。

## 端点

| 方法 | 路径 | 说明 | 实现阶段 |
| --- | --- | --- | --- |
| GET | `/api/v1/health` | 服务状态、版本；不暴露配置或密钥 | P0 ✅ |
| POST | `/api/v1/tasks` | 创建任务，返回 201 与任务对象；`mode: live` 暂返回 501 | P1 ✅ |
| GET | `/api/v1/tasks?limit=&offset=` | 按创建时间倒序分页查询（limit 1..100，默认 20） | P1 ✅ |
| GET | `/api/v1/tasks/:id` | 获取任务快照 | P1 ✅ |
| GET | `/api/v1/tasks/:id/events?afterSeq=n` | 获取持久化事件以供回放（默认 afterSeq=0） | P1 ✅ |
| GET | `/api/v1/tasks/:id/stream` | SSE 推送新事件；事件 ID 使用 `seq`，支持从上次序号续接 | P2 ✅ |
| POST | `/api/v1/tasks/:id/cancel` | 请求取消；终态重复操作保持幂等 | P3 ✅ |
| POST | `/api/v1/tasks/:id/retry` | 创建新任务并关联原任务（`parentTaskId`） | P3 ✅ |

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

- 环境变量：`MODEL_PROVIDER=deepseek` 与 `MODEL_API_KEY` 必填；`MODEL_BASE_URL`（默认 `https://api.deepseek.com`）、`MODEL_NAME`（默认 `deepseek-chat`）可选。密钥仅服务端读取，不进入事件与日志。
- 未配置时创建或重试 live 任务返回 503（`live_model_not_configured`），不返回假成功。
- 适配器走 OpenAI 兼容 chat completions：每次步进重建消息序列（system + prompt + 历史输出 / 工具调用与结果），携带白名单工具声明；模型返回工具调用则继续循环，返回纯文本即视为最终总结（finish）。
- 每次模型调用与工具执行共用 `STEP_TIMEOUT_MS` 步超时预算，且可被取消信号中止。

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

运行器只允许调用注册表内工具（白名单）；单步执行受 `STEP_TIMEOUT_MS` 超时约束，任务总步数受 `MAX_STEPS` 上限约束，超出即失败（`timeout` / `max_steps_exceeded`）。
