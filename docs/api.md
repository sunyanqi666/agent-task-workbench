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
| GET | `/api/v1/tasks/:id/stream` | SSE 推送新事件；事件 ID 使用 `seq`，支持从上次序号续接 | P2 |
| POST | `/api/v1/tasks/:id/cancel` | 请求取消；终态重复操作保持幂等 | P3 |
| POST | `/api/v1/tasks/:id/retry` | 创建新任务并关联原任务（`parentTaskId`） | P3 |

### 示例（P1 已实现端点）

```bash
# 创建任务（demo 模式）：POST 后异步执行
curl -X POST http://localhost:3000/api/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt": "计算 (12+8)*3 的结果"}'
# → 201 {"id": "…", "status": "queued", "mode": "demo", …}

# 查看终态与事件回放
curl http://localhost:3000/api/v1/tasks/<id>
curl "http://localhost:3000/api/v1/tasks/<id>/events?afterSeq=0"
```

创建后事件序列（demo 表达式任务）：
`task.created → task.started → model.output → tool.started → tool.completed → model.output → task.completed`

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
