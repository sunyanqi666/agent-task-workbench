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
| POST | `/api/v1/tasks` | 创建任务，返回 201 与任务对象 | P1 |
| GET | `/api/v1/tasks` | 按创建时间倒序分页查询 | P1 |
| GET | `/api/v1/tasks/:id` | 获取任务快照 | P1 |
| GET | `/api/v1/tasks/:id/events?afterSeq=n` | 获取持久化事件以供回放 | P1 |
| GET | `/api/v1/tasks/:id/stream` | SSE 推送新事件；事件 ID 使用 `seq`，支持从上次序号续接 | P2 |
| POST | `/api/v1/tasks/:id/cancel` | 请求取消；终态重复操作保持幂等 | P3 |
| POST | `/api/v1/tasks/:id/retry` | 创建新任务并关联原任务（`parentTaskId`） | P3 |

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
