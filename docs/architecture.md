# 系统结构与运行方式

## 组成

```
┌──────────────┐       /api/v1（JSON / SSE）      ┌──────────────┐
│  apps/web    │  ────────────────────────────▶  │  apps/api    │
│  React+Vite  │   开发：Vite 代理到 127.0.0.1:3000 │  Fastify     │
└──────────────┘                                  └──────┬───────┘
                                                         │ node:sqlite
                                                  ┌──────▼───────┐
                                                  │  workbench.db │
                                                  │ （版本化迁移） │
                                                  └──────────────┘
        packages/contracts ── 前后端共用的领域类型、状态规则、事件与错误契约
```

- **apps/web**：React + TypeScript + Vite。已实现任务创建表单（模式与模型选择，模型列表来自 `GET /api/v1/models` 受控目录）、任务列表（轮询刷新）、任务详情与事件时间线（含取消 / 重试操作，meta 区展示所选模型与累计 token 用量）；详情页先全量回放历史事件再经 SSE 续接实时增量，按 `seq` 幂等合并，刷新页面可恢复现场（hash 路由 `#/tasks/:id`，不引入路由库）。
- **apps/api**：Fastify + TypeScript。分层已落地：
  - `routes/` 只做输入校验与响应组装，不触碰数据库细节；SSE 端点在 `routes/tasks` 内以「先订阅缓冲 → 回放 → flush」的顺序实现，避免实时事件与回放乱序；
  - `services/taskService` 是唯一读写 `tasks` / `task_events` 的模块，状态机校验与「状态更新 + 事件追加同事务」的不变量在此强制执行；
  - `services/eventBus` 进程内订阅-发布：taskService 在**事务提交成功后**广播事件，订阅方（SSE 流）读到的必然是已持久化数据；单进程内存语义，重启后靠数据库回放恢复；
  - `runner/`（runTask + 模型适配层）驱动 模型 → 工具 循环，受 `MAX_STEPS` 与 `STEP_TIMEOUT_MS` 约束，异常兜底为任务终态而非悬挂；模型适配含 `DemoModel`（确定性模拟）与 `LiveModel`（DeepSeek，OpenAI 兼容 chat completions，密钥仅服务端）；运行器按任务创建时固化的 `modelId` 调用所选模型，并把供应商每次响应的 token 用量累加到任务行（快照经 `usage` 返回，不进入事件流）；取消为协作式——运行器经注册表登记 `AbortController`，取消路由触发信号，步间 / 模型调用 / 工具执行处响应，取消后不再写入过程事件；
  - `tools/` 为白名单工具注册表（参数校验、拒绝未声明参数），默认工具仅纯计算（`calculate`、`text_stats`）。
- **packages/contracts**：前后端共享的数据契约（任务、事件、工具、错误格式），单一事实来源。

## 运行方式

- **开发**：`pnpm dev` 同时启动 API（3000）与 Web（5173）；浏览器经 Vite 代理访问 `/api/v1`，不硬编码跨域地址。
- **演示 / 生产**：`pnpm build` 构建前端后，API 直接托管 `apps/web/dist`，单进程运行（`pnpm start`）。API 根地址也可在构建时注入以分别部署。
- **CI**：GitHub Actions（`.github/workflows/ci.yml`）在 push / PR 时以 Node 22 + pnpm 全新安装依赖并运行 `typecheck / lint / test`。

## 数据

- SQLite（Node 内置 `node:sqlite`，无原生依赖），数据库文件默认在 `apps/api/data/`。
- 结构变更通过 `apps/api/migrations/NNN_*.sql` 版本化迁移，进度记录在 `PRAGMA user_version`，可在全新数据库上重复执行。
- 任务事件表（`task_events`）是回放的唯一来源，实时流与回放共用同一事件结构。

## 模式与安全

- **demo（默认）**：确定性模拟事件，不读取任何模型密钥。
- **live**：真实模型服务；密钥仅从服务端环境变量（`.env`）读取，绝不下发给前端。
- 工具为白名单机制：统一接口、参数校验、结构化结果；默认不含任意命令 / 任意文件 / 任意外部网址访问。
- 错误响应统一 `{ error: { code, message, requestId } }`；`requestId` 同时进入服务端日志便于排查。
