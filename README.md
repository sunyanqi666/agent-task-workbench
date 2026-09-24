# Agent Task Workbench

面向全栈工程师作品集的 AI 任务工作台：用户创建任务 → 后端执行模型与受限工具调用 → 页面实时展示步骤 → 可取消 / 重试 → 历史可回放。项目参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 与插件思想，独立实现可演示的执行链路。

## 当前进度

- **P0 项目骨架（已完成）**：前后端骨架、数据契约、SQLite 版本化迁移、健康检查、类型检查 / 静态检查 / 最小测试
- **P1 可运行任务（已完成）**：状态机、模拟模型、白名单工具调用循环、事件持久化与回放
- **P2 实时界面（已完成）**：SSE 实时事件流（回放 + 续接）、创建 / 列表 / 详情 / 时间线，刷新后数据一致
- **P3 真实模型与控制（已完成）**：DeepSeek（OpenAI 兼容）live 模式、协作式取消、失败重试（parentTaskId 关联）
- **P4 工程化（进行中）**：CI（GitHub Actions：typecheck / lint / test）✅、生产构建从零启动验收 ✅、模型选择与用量记录（受控模型目录 `GET /api/v1/models`、逐任务 `modelId`、供应商 token 用量累计）✅；容器化 / 演示素材待补

## 快速开始

要求：Node.js ≥ 22.13（内置 `node:sqlite`，无原生依赖）、pnpm（`corepack enable pnpm` 或 `npm i -g pnpm`）。

```bash
pnpm install
pnpm dev
```

- 前端：http://localhost:5173 （Vite 开发服务器，`/api` 代理到 API）
- API：http://localhost:3000
- 健康检查：`curl http://localhost:3000/api/v1/health`

默认演示模式（`demo`），无需任何模型密钥即可启动。配置项见根目录 `.env.example`，复制为 `.env` 后按需修改（密钥仅服务端读取）。

其他命令：

```bash
pnpm typecheck   # 全部包 TypeScript 类型检查
pnpm lint        # ESLint 静态检查
pnpm test        # node:test 测试套件（状态机、运行器、SSE、取消/重试、工具）
pnpm build       # 构建前端产物（apps/web/dist，可由 API 直接托管）
pnpm start       # 生产模式启动 API（托管已构建的前端）
```

## 目录结构

```
├── apps/
│   ├── web/                  # React + TypeScript + Vite；创建表单 / 列表 / 详情时间线（取消 / 重试）
│   └── api/                  # Fastify + TypeScript；路由、任务服务、运行器、工具注册表
│       ├── migrations/       # SQLite 版本化迁移（user_version 记录进度）
│       └── src/
│           ├── app.ts        # buildServer：组装路由与错误处理（可测试入口）
│           ├── index.ts       # 入口：配置加载、数据库、监听
│           ├── config.ts     # 环境变量与 .env 加载（固定从仓库根读取）
│           ├── db.ts         # SQLite 连接、迁移执行与查询助手
│           ├── app.test.ts   # 健康检查与错误结构测试（node:test）
│           └── routes/       # health / tasks 端点
├── packages/
│   └── contracts/            # 前后端共用的领域类型、状态规则、事件与错误契约
├── docs/
│   ├── api.md                # API 契约文档
│   └── architecture.md       # 系统结构与运行方式
├── scripts/dev.sh           # 一键启动前后端
└── pnpm-workspace.yaml
```

## 文档

- [docs/api.md](docs/api.md) — API 契约（端点、数据模型、错误约定）
- [docs/architecture.md](docs/architecture.md) — 系统结构与运行方式
