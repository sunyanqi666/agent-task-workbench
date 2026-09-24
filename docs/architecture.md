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

- **apps/web**：React + TypeScript + Vite。当前为应用壳与 API 连通状态；任务列表、详情与实时步骤在 P2 加入。
- **apps/api**：Fastify + TypeScript。分层已落地：
  - `routes/` 只做输入校验与响应组装，不触碰数据库细节；
  - `services/taskService` 是唯一读写 `tasks` / `task_events` 的模块，状态机校验与「状态更新 + 事件追加同事务」的不变量在此强制执行；
  - `runner/`（runTask + 模型适配层）驱动 模型 → 工具 循环，受 `MAX_STEPS` 与 `STEP_TIMEOUT_MS` 约束，异常兜底为任务终态而非悬挂；
  - `tools/` 为白名单工具注册表（参数校验、拒绝未声明参数），默认工具仅纯计算（`calculate`、`text_stats`）。
- **packages/contracts**：前后端共享的数据契约（任务、事件、工具、错误格式），单一事实来源。

## 运行方式

- **开发**：`pnpm dev` 同时启动 API（3000）与 Web（5173）；浏览器经 Vite 代理访问 `/api/v1`，不硬编码跨域地址。
- **演示 / 生产**：`pnpm build` 构建前端后，API 直接托管 `apps/web/dist`，单进程运行（`pnpm start`）。API 根地址也可在构建时注入以分别部署。

## 数据

- SQLite（Node 内置 `node:sqlite`，无原生依赖），数据库文件默认在 `apps/api/data/`。
- 结构变更通过 `apps/api/migrations/NNN_*.sql` 版本化迁移，进度记录在 `PRAGMA user_version`，可在全新数据库上重复执行。
- 任务事件表（`task_events`）是回放的唯一来源，实时流与回放共用同一事件结构。

## 模式与安全

- **demo（默认）**：确定性模拟事件，不读取任何模型密钥。
- **live**：真实模型服务；密钥仅从服务端环境变量（`.env`）读取，绝不下发给前端。
- 工具为白名单机制：统一接口、参数校验、结构化结果；默认不含任意命令 / 任意文件 / 任意外部网址访问。
- 错误响应统一 `{ error: { code, message, requestId } }`；`requestId` 同时进入服务端日志便于排查。
