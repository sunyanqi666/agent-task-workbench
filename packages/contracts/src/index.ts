/**
 * 领域数据契约 —— 单一事实来源
 * 前端（apps/web）与后端（apps/api）共同引用本文件。
 * 修改后需同步 docs/api.md，并运行 `pnpm typecheck` 验证。
 */

export const APP_VERSION = '0.1.0';

// ===== 模型模式 =====
/** demo：确定性模拟事件，不读取密钥；live：真实模型服务（P3 接入） */
export type ModelMode = 'demo' | 'live';

// ===== 任务状态机 =====
// queued -> running -> completed | failed
// queued | running -> canceled（用户取消）
// 终态不可再迁移；重试生成新任务并指向原任务，不改写历史。
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

/** 合法状态迁移表；状态机外的迁移必须拒绝（P1 由任务服务强制执行） */
export const TASK_STATUS_TRANSITIONS: Readonly<
  Record<TaskStatus, readonly TaskStatus[]>
> = {
  queued: ['running', 'canceled'],
  running: ['completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

// ===== 任务 =====
export interface Task {
  id: string;
  /** 用户完整任务输入；非空且长度受限（服务端校验） */
  prompt: string;
  status: TaskStatus;
  mode: ModelMode;
  /** 重试产生的新任务指向原任务 id；首次创建为 null */
  parentTaskId: string | null;
  /** 以下时间均为 ISO 8601 字符串 */
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 终态失败原因码；进行中或成功为 null。详细信息看事件（task.failed） */
  errorCode: TaskErrorCode | null;
}

export type TaskErrorCode =
  | 'model_error' // 模型调用失败
  | 'tool_error' // 工具执行失败
  | 'timeout' // 步骤或任务超时
  | 'max_steps_exceeded' // 超过步数上限
  | 'canceled' // 用户取消
  | 'internal'; // 其他未分类错误

// ===== 任务事件 =====
// 事件是唯一的过程记录载体：实时流（SSE）与历史回放共用同一结构，
// 全部持久化到 SQLite 的 task_events 表；载荷按类型校验，不含密钥。
export type TaskEventType =
  | 'task.created'
  | 'task.started'
  | 'model.output'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'task.completed'
  | 'task.failed'
  | 'task.canceled';

export interface TaskEvent<P = unknown> {
  id: string;
  taskId: string;
  /** 任务内单调递增；回放顺序由 (taskId, seq) 决定，SSE 事件 ID 也使用 seq */
  seq: number;
  type: TaskEventType;
  payload: P;
  createdAt: string;
}

/** 各事件类型的 payload 形状 */
export interface TaskEventPayloads {
  'task.created': { prompt: string };
  'task.started': Record<string, never>;
  'model.output': { text: string };
  'tool.started': { name: string; input: Record<string, unknown> };
  'tool.completed': { name: string; output?: unknown; durationMs: number };
  'tool.failed': { name: string; error: string };
  'task.completed': { summary: string };
  'task.failed': { errorCode: TaskErrorCode; message: string };
  'task.canceled': Record<string, never>;
}

// ===== 工具契约 =====
export interface ToolContext {
  taskId: string;
  /** 取消信号：任务被取消后置为 aborted，工具应及时停止 */
  signal: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolDefinition<I = Record<string, unknown>> {
  name: string;
  description: string;
  /** 简化 JSON Schema：注册时校验参数，拒绝未声明参数 */
  inputSchema: {
    type: 'object';
    properties: Record<
      string,
      { type: 'string' | 'number' | 'boolean'; description?: string }
    >;
    required?: string[];
  };
  /** 工具执行：只允许低风险操作（白名单），不提供任意命令/文件/网址 */
  execute: (input: I, context: ToolContext) => Promise<ToolResult>;
}

// ===== API 通用响应 =====
export interface ApiError {
  error: { code: string; message: string; requestId: string };
}

export interface HealthInfo {
  status: 'ok';
  db: 'ok';
  version: string;
  uptimeSec: number;
}
