/**
 * 领域数据契约 —— 单一事实来源
 * 前端（apps/web）与后端（apps/api）共同引用本文件。
 * 修改后需同步 docs/api.md，并运行 `pnpm typecheck` 验证。
 */

export const APP_VERSION = '0.1.0';

// ===== 模型模式 =====
/** demo：确定性模拟事件，不读取密钥；live：真实模型服务（P3 接入） */
export type ModelMode = 'demo' | 'live';

// ===== 模型目录（P4：逐任务选模型的第一片） =====
export interface ModelInfo {
  /** 模型 id：创建任务时提交的受控标识（如 deepseek-flash） */
  id: string;
  /** 展示名：前端直接渲染 */
  label: string;
}

/**
 * 服务端受控模型目录：前端只能提交目录中的 id，由 GET /api/v1/models 下发。
 * 当前为同一供应商（DeepSeek）的两个模型；多供应商适配在 P5 扩展。
 * 注意：旧名 deepseek-chat / deepseek-reasoner 已于 2026-07-24 被供应商停用，不得回退。
 */
export const AVAILABLE_MODELS: readonly ModelInfo[] = [
  { id: 'deepseek-flash', label: 'DeepSeek Flash（通用 · 快）' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro（旗舰 · 强推理）' },
];

/** 未指定 modelId 时的缺省模型 */
export const DEFAULT_MODEL_ID: string = AVAILABLE_MODELS[0]!.id;

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
/** 供应商返回的 token 用量（live 任务逐次累加；demo 任务恒为 0） */
export interface TaskUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface Task {
  id: string;
  /** 用户完整任务输入；非空且长度受限（服务端校验） */
  prompt: string;
  status: TaskStatus;
  mode: ModelMode;
  /** 创建时固化的模型 id（来自 AVAILABLE_MODELS；重试沿用原任务选择） */
  modelId: string;
  /** 供应商返回的累计用量；随每次模型响应累加 */
  usage: TaskUsage;
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

// ===== 任务 API 契约（P1） =====
/** prompt 长度上限：服务端与前端共用 */
export const PROMPT_MAX_LENGTH = 8000;

/** POST /api/v1/tasks 请求体 */
export interface CreateTaskInput {
  /** 非空，去除首尾空白后 1..PROMPT_MAX_LENGTH 字符 */
  prompt: string;
  /** 缺省为 demo；live 在 P3 接入 */
  mode?: ModelMode;
  /** 所选模型 id：必须是 AVAILABLE_MODELS 中的项，非法值 400；缺省 DEFAULT_MODEL_ID */
  modelId?: string;
}

/** GET /api/v1/models 响应：服务端受控模型目录 */
export interface ModelListResponse {
  models: ModelInfo[];
}

/** GET /api/v1/tasks 响应：按创建时间倒序分页 */
export interface TaskListResponse {
  items: Task[];
  total: number;
  limit: number;
  offset: number;
}

/** GET /api/v1/tasks/:id/events 响应：按 seq 升序 */
export interface TaskEventsResponse {
  events: TaskEvent[];
}
